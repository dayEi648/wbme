import { NestFactory } from '@nestjs/core';
import { createServer } from 'node:http';
import { WorkerModule } from './worker.module';
import { WorkerRuntimeService } from './worker-runtime.service';

/** 优雅停机宽限（毫秒，主 PRD §9.13） */
const SHUTDOWN_GRACE_MS = 15_000;

/** 健康探针默认端口（compose 注入 WORKER_HEALTH_URL 供健康状态页探测） */
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3105);

/**
 * Worker 部署单元入口。
 * 不监听业务 HTTP 端口，承载 Outbox 调度与 BullMQ 消费者（主 PRD §9.1）；
 * 仅提供最小健康探针 HTTP 服务（L37/backstage PRD §11）：
 * `/healthz` 存活（进程活着恒 200）、`/readyz` 就绪（Redis 连接正常且未停机）。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  const runtime = app.get(WorkerRuntimeService);

  // 最小健康探针（免登录；仅返回状态，不承载业务数据；与业务端口分离）
  const healthServer = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url === '/readyz') {
      // 就绪探针异步探测 Redis + PostgreSQL（问题17：反映 PG 运行期故障）
      void runtime.getHealth().then((health) => {
        if (health.ready) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'unready' }));
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
  });
  healthServer.listen(HEALTH_PORT, '0.0.0.0');
  console.log(`[worker] 健康探针 listening on http://localhost:${HEALTH_PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // 就绪探针立即失败（主 PRD §9.13），再停止调度与消费
    runtime.beginShutdown();
    console.log(`[worker] 收到 ${signal}，开始优雅停机 ...`);
    const timer = setTimeout(() => {
      console.error('[worker] 优雅停机超时，强制退出');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    try {
      healthServer.close();
      await app.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      console.error('[worker] 停机失败', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  console.error('[worker] 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
