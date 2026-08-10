import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request } from 'express';

/** 维护标记文件名（由恢复执行器在数据库外持久化目录原子维护） */
const MAINTENANCE_MARKER_FILE = 'maintenance.marker';

/** 维护期间唯一放行的公开探针 */
const PUBLIC_PROBE_PATHS = new Set(['/healthz', '/readyz']);

/**
 * 返回当前部署单元读取的维护标记路径。
 *
 * @returns 维护标记的绝对或开发默认路径
 */
export function maintenanceMarkerPath(): string {
  const dir = process.env.RESTORE_STATE_DIR?.trim() || '.agents/restore-state';
  return join(dir, MAINTENANCE_MARKER_FILE);
}

/**
 * 检查是否处于维护状态。
 *
 * 仅明确的 ENOENT 表示“未进入维护”；权限、I/O 与挂载错误必须上抛，由调用方
 * 以失败安全方式处理，避免恢复中因标记不可读而继续放行写入。
 *
 * @returns 标记存在时为 true
 * @throws 维护标记无法可靠读取
 */
export async function isMaintenanceActive(): Promise<boolean> {
  try {
    await readFile(maintenanceMarkerPath(), 'utf8');
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * 断言当前请求不在维护状态。
 *
 * @throws SYSTEM_MAINTENANCE 标记存在或标记无法可靠读取
 */
export async function assertNotMaintenance(): Promise<void> {
  try {
    if (await isMaintenanceActive()) {
      throw new BusinessException(frameworkErrors.SYSTEM_MAINTENANCE);
    }
  } catch (error) {
    if (error instanceof BusinessException) {
      throw error;
    }
    throw new BusinessException(frameworkErrors.SYSTEM_MAINTENANCE);
  }
}

/**
 * 恢复维护状态拦截器（backstage PRD §10）。
 *
 * 标记存在时拒绝所有业务读写与内部业务路由，仅保留 healthz/readyz。Nginx 在公网
 * 入口先行拦截，本拦截覆盖容器私网直连及 Nginx 异常时的应用层兜底。
 */
@Injectable()
export class MaintenanceInterceptor implements NestInterceptor {
  /**
   * 拦截请求并在维护状态下拒绝。
   *
   * @param context Nest 执行上下文
   * @param next 后续处理器
   * @returns 后续响应流
   * @throws SYSTEM_MAINTENANCE 维护中或标记读取异常
   */
  async intercept(context: ExecutionContext, next: CallHandler): Promise<import('rxjs').Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path ?? request.originalUrl ?? '';
    if (!PUBLIC_PROBE_PATHS.has(path)) {
      await assertNotMaintenance();
    }
    return next.handle();
  }
}

/** 判断错误是否仅表示文件不存在 */
function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
