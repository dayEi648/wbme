import { Injectable } from '@nestjs/common';
import { HEALTH_STATUS_FUNCTION_CODE } from '@wbme/contracts';
import { readDiskStatus } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';

/**
 * 服务探针配置（环境变量覆盖）。
 * asset/hr/fin 与 platform-core/worker/recovery-executor 一并探测（backstage PRD §11）。
 */
const SERVICE_PROBE_ENV: Record<string, string> = {
  'platform-core': 'PLATFORM_CORE_HEALTH_URL',
  asset: 'ASSET_HEALTH_URL',
  hr: 'HR_HEALTH_URL',
  fin: 'FIN_HEALTH_URL',
  worker: 'WORKER_HEALTH_URL',
  'recovery-executor': 'RECOVERY_EXECUTOR_HEALTH_URL',
};

/** 按模块+任务类型分组的聚合行 */
interface ModuleTypeGroupRow {
  module: string;
  taskType: string;
  pendingEnqueue: number;
  queued: number;
  running: number;
  failed24h: number;
  lastFailureAt: Date | null;
}

/**
 * 健康状态聚合（任务概览 + 服务探针 + 真实磁盘使用率）。
 */
@Injectable()
export class HealthStatusService {
  constructor(private readonly prisma: PrismaService) {}

  /** 聚合健康状态 */
  async getOverview(): Promise<unknown> {
    const [services, tasks, disk] = await Promise.all([
      this.probeServices(),
      this.summarizeTasks(),
      readDiskStatus(),
    ]);
    return { services, tasks, disk, feature: HEALTH_STATUS_FUNCTION_CODE };
  }

  private async probeServices(): Promise<Array<{ name: string; alive: boolean; ready: boolean | null }>> {
    const results: Array<{ name: string; alive: boolean; ready: boolean | null }> = [];
    for (const [name, envKey] of Object.entries(SERVICE_PROBE_ENV)) {
      const url = process.env[envKey]?.trim();
      if (!url) {
        results.push({ name, alive: false, ready: null });
        continue;
      }
      try {
        const aliveRes = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(2_000) });
        const readyRes = await fetch(`${url.replace(/\/$/, '')}/readyz`, { signal: AbortSignal.timeout(2_000) });
        results.push({ name, alive: aliveRes.ok, ready: readyRes.ok });
      } catch {
        results.push({ name, alive: false, ready: false });
      }
    }
    return results;
  }

  private async summarizeTasks(): Promise<unknown> {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [pendingEnqueue, queued, running, leaseAnomalies, failed24h, lastFailure] = await Promise.all([
      this.prisma.client.backgroundTask.count({ where: { status: 'PENDING_ENQUEUE' } }),
      this.prisma.client.backgroundTask.count({ where: { status: 'QUEUED' } }),
      this.prisma.client.backgroundTask.count({ where: { status: 'RUNNING' } }),
      this.prisma.client.backgroundTask.count({
        where: { status: 'RUNNING', leaseExpiresAt: { lt: now } },
      }),
      this.prisma.client.backgroundTask.count({
        where: { status: 'FAILED', finishedAt: { gte: dayAgo } },
      }),
      this.prisma.client.backgroundTask.findFirst({
        // 与 failed24h 同口径：仅最近 24 小时滚动窗口内（backstage PRD §11 / 主 PRD §13）
        where: { status: 'FAILED', finishedAt: { gte: dayAgo } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      }),
    ]);
    const byModuleAndType = await this.groupByModuleAndType(dayAgo);
    return {
      overview: { pendingEnqueue, queued, running, leaseAnomalies, failed24h, lastFailureAt: lastFailure?.finishedAt ?? null },
      byModuleAndType,
    };
  }

  /**
   * 按模块 + 任务类型分组：进行中计数 + 24h 失败数 + 最近失败时间（backstage PRD §11）。
   *
   * @param dayAgo 24h 滚动窗口起点
   * @returns 分组汇总（不含任务明细）
   */
  private async groupByModuleAndType(dayAgo: Date): Promise<ModuleTypeGroupRow[]> {
    const rows = await this.prisma.client.$queryRaw<
      Array<{
        module: string;
        task_type: string;
        pending_enqueue: bigint;
        queued: bigint;
        running: bigint;
        failed_24h: bigint;
        last_failure_at: Date | null;
      }>
    >`
      SELECT
        module,
        task_type,
        COUNT(*) FILTER (WHERE status = 'PENDING_ENQUEUE')::bigint AS pending_enqueue,
        COUNT(*) FILTER (WHERE status = 'QUEUED')::bigint AS queued,
        COUNT(*) FILTER (WHERE status = 'RUNNING')::bigint AS running,
        COUNT(*) FILTER (WHERE status = 'FAILED' AND finished_at >= ${dayAgo})::bigint AS failed_24h,
        MAX(finished_at) FILTER (WHERE status = 'FAILED' AND finished_at >= ${dayAgo}) AS last_failure_at
      FROM backstage.background_tasks
      WHERE status IN ('PENDING_ENQUEUE', 'QUEUED', 'RUNNING', 'FAILED')
        AND (
          status IN ('PENDING_ENQUEUE', 'QUEUED', 'RUNNING')
          OR (status = 'FAILED' AND finished_at >= ${dayAgo})
        )
      GROUP BY module, task_type
      ORDER BY module, task_type
    `;
    return rows.map((row) => ({
      module: row.module,
      taskType: row.task_type,
      pendingEnqueue: Number(row.pending_enqueue),
      queued: Number(row.queued),
      running: Number(row.running),
      failed24h: Number(row.failed_24h),
      lastFailureAt: row.last_failure_at,
    }));
  }
}
