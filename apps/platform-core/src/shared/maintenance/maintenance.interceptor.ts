import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request } from 'express';

/** 维护标记文件路径（与恢复执行器同目录；backstage PRD §10 维护状态独立性） */
function maintenanceMarkerPath(): string {
  const dir = process.env.RESTORE_STATE_DIR?.trim() || '.agents/restore-state';
  return join(dir, 'maintenance.marker');
}

/** 只读方法与健康探针豁免（维护期间仅保留探针与恢复通道） */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_PROBE_PATHS = new Set(['/healthz', '/readyz']);

/**
 * 维护状态写拦截（backstage PRD §10）。
 *
 * 恢复执行器在数据库外持久化目录写入维护标记；标记存在时全部写请求
 * 返回 503 SYSTEM_MAINTENANCE，读请求与健康探针放行。
 * 生产环境由 Nginx 同标记只读挂载先行拦截（T10-1），本拦截为应用层兜底。
 */
@Injectable()
export class MaintenanceInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<import('rxjs').Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) {
      return next.handle();
    }
    const path = request.path ?? request.originalUrl ?? '';
    if (PUBLIC_PROBE_PATHS.has(path)) {
      return next.handle();
    }
    await this.assertNotMaintenance();
    return next.handle();
  }

  private async assertNotMaintenance(): Promise<void> {
    try {
      await readFile(maintenanceMarkerPath(), 'utf8');
      throw new BusinessException(frameworkErrors.SYSTEM_MAINTENANCE);
    } catch (error) {
      if (error instanceof BusinessException) {
        throw error;
      }
      // 标记文件不存在（未维护）或读取失败（权限等）：按未维护处理，不阻塞业务
    }
  }
}
