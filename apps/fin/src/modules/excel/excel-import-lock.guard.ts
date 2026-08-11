import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { assertDiskAcceptsCapacityWrites, getRequestContext, setRequestImportLockRelease, setRequestImportStartedAt } from '@wbme/server';
import type { Request, Response } from 'express';
import { PrismaService } from '../../prisma.service';
import { assertFinanceMaintainAccess } from '../../shared/cross-schema-auth';
import { ImportService } from './import.service';

/**
 * 导入并发占用前置守卫（fin PRD §4：并发占用在认证授权完成后、读取上传请求体前取得）。
 *
 * Nest 守卫先于拦截器（Multer 的 FileInterceptor）执行：本守卫完成权限断言与互斥锁获取，
 * 使并发请求在 Multer 缓冲 20 MiB 请求体之前即被拒绝，避免无谓内存占用；
 * 锁句柄写入请求上下文供 ImportService 复用（不再二次获取），释放挂响应关闭 / 请求 aborted
 * 兜底（正常完成/异常/超时/断连均触发）。
 * 磁盘达严重阈值时拒绝新导入（主 PRD §9.13）。
 *
 * 断连竞态：权限/磁盘检查与取锁均为 await，客户端可能在监听器注册前已 abort；
 * 取锁前后须显式探测 aborted/destroyed，否则会留下无人释放的 Redis 锁直至 TTL。
 */
@Injectable()
export class ExcelImportLockGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly imports: ImportService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 认证已在全局 SessionGuard 完成（请求上下文 userId 已写入）
    const userId = getRequestContext()?.userId;
    if (!userId) {
      throw new UnauthorizedException();
    }
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    // 授权断言前置到请求体读取之前
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    // 磁盘严重阈值：停止接受新 Excel 导入（主 PRD §9.13）
    await assertDiskAcceptsCapacityWrites();

    // 认证/磁盘检查期间客户端已断连：不取锁，避免无人释放
    if (isImportRequestAborted(req)) {
      throw new BusinessException(frameworkErrors.REQUEST_TIMEOUT);
    }

    // 互斥锁前置到 Multer 之前；同一请求内 service 经请求上下文复用同一句柄
    const release = await this.imports.acquireImportLock(userId);
    setRequestImportLockRelease(release);
    // 总时限从取得占用并开始接收请求体时计算（fin PRD §4：覆盖上传读取阶段）
    setRequestImportStartedAt(Date.now());

    // 取锁瞬间断连：aborted/close 可能已错过，立即释放
    if (isImportRequestAborted(req)) {
      await release();
      throw new BusinessException(frameworkErrors.REQUEST_TIMEOUT);
    }

    // 释放兜底：响应关闭或请求 aborted（上传中途断连）；service 复用同一句柄幂等释放。
    // 不监听 req 'close'——完整读完请求体后也会触发，而 confirm 仍在执行。
    const onDone = (): void => {
      void release();
    };
    res.on('close', onDone);
    req.on('aborted', onDone);
    return true;
  }
}

/** 客户端是否已断连（await 期间错过事件时仍可探测）。 */
function isImportRequestAborted(req: Request): boolean {
  return Boolean(req.aborted || req.destroyed || req.socket?.destroyed);
}
