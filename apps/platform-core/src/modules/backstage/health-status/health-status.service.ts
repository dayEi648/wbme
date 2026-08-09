import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HEALTH_STATUS_FUNCTION_CODE } from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';

const execFileAsync = promisify(execFile);

/** 磁盘使用率告警阈值 */
const DISK_WARN_RATIO = 0.8;
const DISK_CRITICAL_RATIO = 0.9;

/** 服务探针配置（环境变量覆盖） */
const SERVICE_PROBE_ENV: Record<string, string> = {
  'platform-core': 'PLATFORM_CORE_HEALTH_URL',
  worker: 'WORKER_HEALTH_URL',
  'recovery-executor': 'RECOVERY_EXECUTOR_HEALTH_URL',
};

/**
 * 健康状态聚合（任务概览 + 服务探针 + 磁盘 stub）。
 */
@Injectable()
export class HealthStatusService {
  constructor(private readonly prisma: PrismaService) {}

  /** 聚合健康状态 */
  async getOverview(): Promise<unknown> {
    const [services, tasks, disk] = await Promise.all([
      this.probeServices(),
      this.summarizeTasks(),
      this.readDiskStatus(),
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
        where: { status: 'FAILED' },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      }),
    ]);
    const grouped = await this.prisma.client.$queryRaw<
      Array<{ module: string; task_type: string; status: string; count: bigint }>
    >`
      SELECT module, task_type, status, COUNT(*)::bigint AS count
      FROM backstage.background_tasks
      WHERE status IN ('PENDING_ENQUEUE', 'QUEUED', 'RUNNING')
      GROUP BY module, task_type, status
    `;
    return {
      overview: { pendingEnqueue, queued, running, leaseAnomalies, failed24h, lastFailureAt: lastFailure?.finishedAt ?? null },
      byModuleAndType: grouped.map((row) => ({
        module: row.module,
        taskType: row.task_type,
        status: row.status,
        count: Number(row.count),
      })),
    };
  }

  private async readDiskStatus(): Promise<{ status: 'OK' | 'WARN' | 'CRITICAL'; usageRatio: number | null }> {
    const envRatio = process.env.HEALTH_DISK_USAGE_RATIO?.trim();
    if (envRatio) {
      const usageRatio = Number(envRatio);
      return { status: classifyDisk(usageRatio), usageRatio };
    }
    try {
      const { stdout } = await execFileAsync('df', ['-k', '/']);
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) {
        return { status: 'OK', usageRatio: null };
      }
      const parts = lines[1]?.split(/\s+/) ?? [];
      if (parts.length < 3) {
        return { status: 'OK', usageRatio: null };
      }
      const used = Number(parts[2]);
      const total = Number(parts[1]);
      const usageRatio = total > 0 ? used / total : null;
      return { status: usageRatio === null ? 'OK' : classifyDisk(usageRatio), usageRatio };
    } catch {
      return { status: 'OK', usageRatio: null };
    }
  }
}

function classifyDisk(ratio: number): 'OK' | 'WARN' | 'CRITICAL' {
  if (ratio >= DISK_CRITICAL_RATIO) {
    return 'CRITICAL';
  }
  if (ratio >= DISK_WARN_RATIO) {
    return 'WARN';
  }
  return 'OK';
}
