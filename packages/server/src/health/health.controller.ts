import { Controller, Get, Inject, Optional, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RedisService } from '../redis/redis.service';
import { MIGRATION_READINESS, type MigrationReadinessChecker } from './migration-readiness';
import { Public } from '../session/session.guard';

/**
 * 健康探针（主 PRD §9.13）：免登录（@Public）、仅供 Docker/Nginx 与外部监控使用。
 * 只返回最小存活/就绪状态，不返回依赖地址、错误正文、任务数量或任何业务数据。
 */
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly redis: RedisService,
    @Optional()
    @Inject(MIGRATION_READINESS)
    private readonly migrationReadiness?: MigrationReadinessChecker,
  ) {}

  /** 存活探针：进程活着即 200 */
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * 就绪探针：Redis 就绪 + 迁移版本就绪（主 PRD §9.9，由部署单元注入的
   * MIGRATION_READINESS 检查 PostgreSQL 连通性、悬挂迁移与目录漂移）；
   * 任一失败返回 503 最小状态（细节仅写服务端日志，不进入响应）。
   */
  @Get('readyz')
  async readiness(@Res() res: Response): Promise<void> {
    if (!this.redis.isReady) {
      res.status(503).json({ status: 'unready' });
      return;
    }
    if (this.migrationReadiness) {
      const migration = await this.migrationReadiness.check();
      if (!migration.ready) {
        console.warn(`[readyz] 迁移版本不就绪：${migration.reason ?? '未知原因'}`);
        res.status(503).json({ status: 'unready' });
        return;
      }
    }
    res.json({ status: 'ok' });
  }
}
