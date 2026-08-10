import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { getRequestContext, setRequestImportLockRelease } from '@wbme/server';
import type { Response } from 'express';
import { PrismaService } from '../../prisma.service';
import { assertFinanceMaintainAccess } from '../../shared/cross-schema-auth';
import { ImportService } from './import.service';

/**
 * 导入并发占用前置守卫（fin PRD §4：并发占用在认证授权完成后、读取上传请求体前取得）。
 *
 * Nest 守卫先于拦截器（Multer 的 FileInterceptor）执行：本守卫完成权限断言与互斥锁获取，
 * 使并发请求在 Multer 缓冲 20 MiB 请求体之前即被拒绝，避免无谓内存占用；
 * 锁句柄写入请求上下文供 ImportService 复用（不再二次获取），释放挂响应关闭兜底
 * （正常完成/异常/超时/断连均触发）。
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
    // 授权断言前置到请求体读取之前
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    // 互斥锁前置到 Multer 之前；同一请求内 service 经请求上下文复用同一句柄
    const release = await this.imports.acquireImportLock(userId);
    setRequestImportLockRelease(release);
    const res = context.switchToHttp().getResponse<Response>();
    // 释放兜底：响应关闭（正常完成/异常/超时/断连）时统一释放；service 复用同一句柄幂等释放
    res.on('close', () => {
      void release();
    });
    return true;
  }
}
