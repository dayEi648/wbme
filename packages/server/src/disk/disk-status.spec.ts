import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameworkErrors } from '@wbme/contracts';
import {
  assertDiskAcceptsCapacityWrites,
  classifyDisk,
  diskPathsToMeasure,
  diskThresholds,
  readDiskStatus,
  readLocalDiskStatus,
} from './disk-status';

describe('disk-status（主 PRD §9.13）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('diskThresholds 默认 0.8/0.9，可由环境变量覆盖', () => {
    expect(diskThresholds()).toEqual({ warn: 0.8, critical: 0.9 });
    vi.stubEnv('HEALTH_DISK_WARN_RATIO', '0.7');
    vi.stubEnv('HEALTH_DISK_CRITICAL_RATIO', '0.95');
    expect(diskThresholds()).toEqual({ warn: 0.7, critical: 0.95 });
  });

  it('classifyDisk 按阈值边界分类', () => {
    expect(classifyDisk(0.79)).toBe('OK');
    expect(classifyDisk(0.8)).toBe('WARN');
    expect(classifyDisk(0.89)).toBe('WARN');
    expect(classifyDisk(0.9)).toBe('CRITICAL');
  });

  it('diskPathsToMeasure 优先 HEALTH_DISK_PATHS，否则含 / 与恢复持久化目录', () => {
    vi.stubEnv('HEALTH_DISK_PATHS', '/data/pg,/data/redis');
    expect(diskPathsToMeasure()).toEqual(['/data/pg', '/data/redis']);
    vi.unstubAllEnvs();
    vi.stubEnv('RESTORE_STATE_DIR', '/opt/wbme/persist/restore-state');
    expect(diskPathsToMeasure()).toEqual(['/', '/opt/wbme/persist/restore-state']);
  });

  it('任一目标路径无法测量时标记不可用且不伪装为 OK', async () => {
    vi.stubEnv('HEALTH_DISK_PATHS', '/data/postgres,/data/redis,/data/restore-state');
    await expect(readLocalDiskStatus(async (path) => (path === '/data/redis' ? null : 0.5))).resolves.toEqual({
      status: 'CRITICAL',
      usageRatio: null,
      measurementAvailable: false,
    });
  });

  it('完整测量时取最高使用率分类', async () => {
    vi.stubEnv('HEALTH_DISK_PATHS', '/data/postgres,/data/redis,/data/restore-state');
    await expect(readLocalDiskStatus(async (path) => (path === '/data/redis' ? 0.91 : 0.5))).resolves.toEqual({
      status: 'CRITICAL',
      usageRatio: 0.91,
      measurementAvailable: true,
    });
  });

  it('配置集中探针时使用内部令牌读取真实聚合状态', async () => {
    vi.stubEnv('HEALTH_DISK_STATUS_URL', 'http://recovery-executor:43090');
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'internal-token');
    vi.stubEnv('DISK_STATUS_CALLER', 'platform-core');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'WARN', usageRatio: 0.85, measurementAvailable: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readDiskStatus()).resolves.toEqual({ status: 'WARN', usageRatio: 0.85, measurementAvailable: true });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://recovery-executor:43090/recovery/disk'),
      expect.objectContaining({
        headers: { authorization: 'Bearer internal-token', 'x-wbme-caller': 'platform-core' },
      }),
    );
  });

  it('集中探针响应无效时按不可测量失败安全处理', async () => {
    vi.stubEnv('HEALTH_DISK_STATUS_URL', 'http://recovery-executor:43090');
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'internal-token');
    vi.stubEnv('DISK_STATUS_CALLER', 'platform-core');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'OK' }) }));

    await expect(readDiskStatus()).resolves.toEqual({
      status: 'CRITICAL',
      usageRatio: null,
      measurementAvailable: false,
    });
  });

  it('assertDiskAcceptsCapacityWrites 对不可测量与严重阈值分别拒绝', async () => {
    await expect(
      assertDiskAcceptsCapacityWrites(async () => ({ status: 'CRITICAL', usageRatio: null, measurementAvailable: false })),
    ).rejects.toMatchObject({ entry: frameworkErrors.DEPENDENCY_UNAVAILABLE });
    await expect(
      assertDiskAcceptsCapacityWrites(async () => ({ status: 'CRITICAL', usageRatio: 0.95, measurementAvailable: true })),
    ).rejects.toMatchObject({ entry: frameworkErrors.DISK_SPACE_CRITICAL });
  });
});
