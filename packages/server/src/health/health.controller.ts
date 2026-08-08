import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RedisService } from '../redis/redis.service';
import { Public } from '../session/session.guard';

/**
 * 健康探针（主 PRD §9.13）：免登录（@Public）、仅供 Docker/Nginx 与外部监控使用。
 * 只返回最小存活/就绪状态，不返回依赖地址、错误正文、任务数量或任何业务数据。
 */
@Public()
@Controller()
export class HealthController {
  constructor(private readonly redis: RedisService) {}

  /** 存活探针：进程活着即 200 */
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * 就绪探针：依赖（Redis）就绪返回 200；任一必需依赖失败返回 503。
   * platform-core 的 base/backstage 必需依赖在后续阶段（T1 起）随数据库接入扩展。
   */
  @Get('readyz')
  readiness(@Res() res: Response): void {
    if (!this.redis.isReady) {
      res.status(503).json({ status: 'unready' });
      return;
    }
    res.json({ status: 'ok' });
  }
}
