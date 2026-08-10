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
    vi.restoreAllMocks();
  });

  it('getOverview 聚合 services/tasks/disk 与 feature 编码', async () => {
    vi.stubEnv('PLATFORM_CORE_HEALTH_URL', 'http://pc:3000');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const service = makeService();

    const overview = (await service.getOverview()) as {
      services: Array<{ name: string; alive: boolean; ready: boolean | null }>;
      tasks: { overview: { pendingEnqueue: number } };
      disk: { status: string; usageRatio: number | null };
      feature: string;
    };

    expect(overview.feature).toBe('health_status');
    expect(overview.services).toContainEqual({ name: 'platform-core', alive: true, ready: true });
    // 未配置 env 的服务探针：alive=false、ready=null（不误报）
    expect(overview.services).toContainEqual({ name: 'asset', alive: false, ready: null });
    expect(overview.services).toContainEqual({ name: 'hr', alive: false, ready: null });
    expect(overview.services).toContainEqual({ name: 'fin', alive: false, ready: null });
    expect(overview.services).toContainEqual({ name: 'worker', alive: false, ready: null });
    expect(overview.tasks.overview.pendingEnqueue).toBe(0);
    expect(['OK', 'WARN', 'CRITICAL']).toContain(overview.disk.status);
  });

  describe('服务探针', () => {
    it('配置 URL 且探针失败时 alive/ready=false（降级不抛错）', async () => {
      vi.stubEnv('PLATFORM_CORE_HEALTH_URL', 'http://pc:3000');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
      const overview = (await makeService().getOverview()) as {
        services: Array<{ name: string; alive: boolean; ready: boolean | null }>;
      };
      expect(overview.services).toContainEqual({ name: 'platform-core', alive: false, ready: false });
    });

    it('未配置任何 URL 时全部标记不可探', async () => {
      const overview = (await makeService().getOverview()) as {
        services: Array<{ name: string; alive: boolean; ready: boolean | null }>;
      };
      expect(overview.services.every((s) => s.alive === false && s.ready === null)).toBe(true);
      expect(overview.services.map((s) => s.name)).toEqual(
        expect.arrayContaining(['platform-core', 'asset', 'hr', 'fin', 'worker', 'recovery-executor']),
      );
    });
  });

  describe('任务概览', () => {
    it('按 module/task_type 聚合含 failed24h/lastFailureAt 且不展开任务明细', async () => {
      const prisma = {
        client: {
          backgroundTask: {
            count: vi.fn().mockResolvedValue(2),
            findFirst: vi.fn().mockResolvedValue({ finishedAt: new Date('2026-08-01T00:00:00Z') }),
          },
          $queryRaw: vi.fn().mockResolvedValue([
            {
              module: 'backstage',
              task_type: 'IMMEDIATE_BACKUP',
              pending_enqueue: 0n,
              queued: 0n,
              running: 1n,
              failed_24h: 3n,
              last_failure_at: new Date('2026-08-01T00:00:00Z'),
            },
          ]),
        },
      };
      const service = new HealthStatusService(prisma as never);
      const tasks = (await (service as unknown as { summarizeTasks(): Promise<unknown> }).summarizeTasks()) as {
        overview: { leaseAnomalies: number; failed24h: number; lastFailureAt: Date | null };
        byModuleAndType: Array<{
          module: string;
          taskType: string;
          pendingEnqueue: number;
          queued: number;
          running: number;
          failed24h: number;
          lastFailureAt: Date | null;
        }>;
      };
      expect(tasks.overview.leaseAnomalies).toBe(2);
      expect(tasks.overview.lastFailureAt).toEqual(new Date('2026-08-01T00:00:00Z'));
      expect(tasks.byModuleAndType).toEqual([
        {
          module: 'backstage',
          taskType: 'IMMEDIATE_BACKUP',
          pendingEnqueue: 0,
          queued: 0,
          running: 1,
          failed24h: 3,
          lastFailureAt: new Date('2026-08-01T00:00:00Z'),
        },
      ]);
      expect(prisma.client.$queryRaw).toHaveBeenCalled();
    });
  });

  describe('磁盘状态', () => {
    it('真实读取磁盘状态结构合法（无 stub 造假）', async () => {
      const disk = (await makeService().getOverview()) as { disk: { status: string; usageRatio: number | null } };
      expect(['OK', 'WARN', 'CRITICAL']).toContain(disk.disk.status);
      if (disk.disk.usageRatio !== null) {
        expect(disk.disk.usageRatio).toBeGreaterThanOrEqual(0);
        expect(disk.disk.usageRatio).toBeLessThanOrEqual(1);
      }
    });
  });
});
