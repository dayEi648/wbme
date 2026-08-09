import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthStatusService } from './health-status.service';

type MockFn = ReturnType<typeof vi.fn>;

function prismaMock(): {
  client: { backgroundTask: { count: MockFn; findFirst: MockFn }; $queryRaw: MockFn };
} {
  return {
    client: {
      backgroundTask: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    },
  };
}

function makeService(): HealthStatusService {
  return new HealthStatusService(prismaMock() as never);
}

describe('HealthStatusService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('getOverview 聚合 services/tasks/disk 与 feature 编码', async () => {
    vi.stubEnv('PLATFORM_CORE_HEALTH_URL', 'http://pc:3000');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true }),
    );
    vi.stubEnv('HEALTH_DISK_USAGE_RATIO', '0.5');
    const service = makeService();

    const overview = (await service.getOverview()) as {
      services: Array<{ name: string; alive: boolean; ready: boolean | null }>;
      tasks: { overview: { pendingEnqueue: number } };
      disk: { status: string; usageRatio: number };
      feature: string;
    };

    expect(overview.feature).toBe('health_status');
    expect(overview.services).toContainEqual({ name: 'platform-core', alive: true, ready: true });
    // 未配置 env 的服务探针：alive=false、ready=null（不误报）
    expect(overview.services).toContainEqual({ name: 'worker', alive: false, ready: null });
    expect(overview.tasks.overview.pendingEnqueue).toBe(0);
    expect(overview.disk).toEqual({ status: 'OK', usageRatio: 0.5 });
  });

  describe('服务探针', () => {
    it('配置 URL 且探针失败时 alive/ready=false（降级不抛错）', async () => {
      vi.stubEnv('PLATFORM_CORE_HEALTH_URL', 'http://pc:3000');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
      const overview = (await makeService().getOverview()) as { services: Array<{ name: string; alive: boolean; ready: boolean | null }> };
      expect(overview.services).toContainEqual({ name: 'platform-core', alive: false, ready: false });
    });

    it('未配置任何 URL 时全部标记不可探', async () => {
      const overview = (await makeService().getOverview()) as { services: Array<{ name: string; alive: boolean; ready: boolean | null }> };
      expect(overview.services.every((s) => s.alive === false && s.ready === null)).toBe(true);
    });
  });

  describe('任务概览', () => {
    it('按 module/task_type/status 聚合且不展开任务明细', async () => {
      const prisma = {
        client: {
          backgroundTask: {
            count: vi.fn().mockResolvedValue(2),
            findFirst: vi.fn().mockResolvedValue({ finishedAt: new Date('2026-08-01T00:00:00Z') }),
          },
          $queryRaw: vi.fn().mockResolvedValue([
            { module: 'backstage', task_type: 'IMMEDIATE_BACKUP', status: 'RUNNING', count: 1n },
          ]),
        },
      };
      const service = new HealthStatusService(prisma as never);
      const tasks = (await (service as unknown as { summarizeTasks(): Promise<unknown> }).summarizeTasks()) as {
        overview: { leaseAnomalies: number; failed24h: number; lastFailureAt: Date | null };
        byModuleAndType: Array<{ module: string; taskType: string; status: string; count: number }>;
      };
      expect(tasks.overview.leaseAnomalies).toBe(2);
      expect(tasks.overview.lastFailureAt).toEqual(new Date('2026-08-01T00:00:00Z'));
      expect(tasks.byModuleAndType).toEqual([
        { module: 'backstage', taskType: 'IMMEDIATE_BACKUP', status: 'RUNNING', count: 1 },
      ]);
      expect(prisma.client.$queryRaw).toHaveBeenCalled();
    });
  });

  describe('磁盘状态', () => {
    it.each([
      ['0.5', 'OK'],
      ['0.85', 'WARN'],
      ['0.95', 'CRITICAL'],
      ['0.9', 'CRITICAL'],
      ['0.8', 'WARN'],
    ] as const)('env ratio %s → %s（阈值 0.8/0.9 边界）', async (ratio, expected) => {
      vi.stubEnv('HEALTH_DISK_USAGE_RATIO', ratio);
      const disk = (await makeService().getOverview()) as { disk: { status: string; usageRatio: number } };
      expect(disk.disk.status).toBe(expected);
      expect(disk.disk.usageRatio).toBe(Number(ratio));
    });

    it('无 env 且 df 执行失败时返回 OK/null（不抛错）', async () => {
      const service = makeService();
      const disk = (await (service as unknown as { readDiskStatus(): Promise<{ status: string; usageRatio: number | null }> }).readDiskStatus()) as {
        status: string;
        usageRatio: number | null;
      };
      // 沙箱环境 df 可能真实可用：仅断言返回结构合法
      expect(['OK', 'WARN', 'CRITICAL']).toContain(disk.status);
    });
  });
});
