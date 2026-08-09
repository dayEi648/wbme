import { Injectable } from '@nestjs/common';

/**
 * 优雅停机状态（主 PRD §9.13）。
 *
 * 服务收到 SIGTERM/SIGINT 后由入口立即调用 beginShutdown()：就绪探针随即返回
 * 503，编排层（Compose healthcheck / Nginx）不再把新流量路由到本实例；
 * 已进入的请求与任务在固定宽限内到达安全事务边界，随后关闭 HTTP、PostgreSQL、
 * Redis 等客户端退出。进程内单一实例语义，无需持久化。
 */
@Injectable()
export class ShutdownStateService {
  private shuttingDown = false;

  /** 标记开始停机（幂等；仅允许进入，不提供退出——停机不可逆） */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** 当前是否处于停机流程（就绪探针据此返回 503） */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}
