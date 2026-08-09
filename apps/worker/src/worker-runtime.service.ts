import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { assertRedisAvailable, createRedisClient } from '@wbme/server';
import { BackgroundTaskWorker } from './background-task-worker';
import { createTaskQueue, OutboxScheduler } from './outbox-scheduler';
import { QueueMaintenance } from './queue-maintenance';
import { createSqlClient } from './sql/pg-client';
import { createRawSqlClient } from './sql/raw-sql-adapter';

/** Worker 运行时：Outbox 调度 + BullMQ 消费 + 队列维护 */
@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool | null = null;
  private redis: Redis | null = null;
  private outboxScheduler: OutboxScheduler | null = null;
  private taskWorker: BackgroundTaskWorker | null = null;
  private queueMaintenance: QueueMaintenance | null = null;
  private shuttingDown = false;

  constructor(private readonly config: ConfigService) {}

  /**
   * 启动 Redis 探测、PG 连接、调度器与 Worker。
   */
  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.get<string>('REDIS_URL');
    const databaseUrl = this.config.get<string>('DATABASE_URL');
    if (!redisUrl) {
      throw new Error('REDIS_URL 未配置，Worker 无法启动（主 PRD §9.8）');
    }
    if (!databaseUrl) {
      throw new Error('DATABASE_URL 未配置，Worker 无法启动');
    }

    this.redis = createRedisClient(redisUrl);
    await assertRedisAvailable(this.redis);

    this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
    await this.pool.query('SELECT 1');

    const sql = createSqlClient(this.pool);
    const rawSql = createRawSqlClient(this.pool);
    const schedulerId = `scheduler:${randomUUID()}`;
    const workerId = `worker:${randomUUID()}`;
    const deployCommit = this.config.get<string>('DEPLOY_COMMIT') ?? 'unknown';

    const queue = createTaskQueue(redisUrl);
    this.outboxScheduler = new OutboxScheduler(sql, queue, schedulerId);
    this.taskWorker = new BackgroundTaskWorker(redisUrl, sql, rawSql, workerId, deployCommit);
    this.queueMaintenance = new QueueMaintenance(queue);

    this.outboxScheduler.start();
    this.taskWorker.start();
    this.queueMaintenance.start();

    console.log(`[worker] 已启动 schedulerId=${schedulerId} workerId=${workerId}`);
  }

  /**
   * 优雅停机：停止调度、关闭 Worker、释放连接。
   */
  async onModuleDestroy(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    console.log('[worker] 收到停机信号，正在优雅关闭 ...');

    if (this.outboxScheduler) {
      this.outboxScheduler.stop();
    }
    if (this.queueMaintenance) {
      this.queueMaintenance.stop();
    }
    if (this.taskWorker) {
      await this.taskWorker.close();
    }
    if (this.redis) {
      this.redis.disconnect();
    }
    if (this.pool) {
      await this.pool.end();
    }
    console.log('[worker] 已关闭');
  }
}
