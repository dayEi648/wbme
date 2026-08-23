import { describe, expect, it } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertBackupObjectEncryption, RecoveryExecutorService } from './recovery-executor.service';

/** 就绪检查所需的控制会话密钥（readiness 依赖） */
const SESSION_SECRET = 'test-session-secret-32-chars-long!!';

describe('RecoveryExecutorService 状态机', () => {
  it('dry-run 管道应到达 DONE', async () => {
    process.env.RESTORE_DRY_RUN = '1';
    process.env.RESTORE_STATE_DIR = '.agents/restore-state-test';
    const service = new RecoveryExecutorService();
    await service.acceptDelivery({ restoreUuid: 'test-uuid', backupId: 1 });
    await new Promise((r) => setTimeout(r, 800));
    const status = await service.getStatus();
    expect(status.manifest?.stage).toBe('DONE');
    expect(status.maintenance).toBe(false);
  });

  it('任一阶段失败保持维护状态并保存原因（人工介入）', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wbme-restore-fail-'));
    process.env.RESTORE_DRY_RUN = '0';
    process.env.RESTORE_STATE_DIR = stateDir;
    // 数据库不可达（无效端口）：PRECHECK 阶段必然失败
    const service = new RecoveryExecutorService({
      databaseUrl: 'postgresql://nobody:nobody@127.0.0.1:1/nope',
      redisUrl: 'redis://127.0.0.1:1',
      storage: {
        getObject: async () => Buffer.from(''),
        listPrefix: async () => [],
      },
    });
    await service.acceptDelivery({ restoreUuid: 'fail-uuid', backupId: 999 });
    // 等待管道失败（PRECHECK 连接失败快速返回）
    await new Promise((r) => setTimeout(r, 800));
    const status = await service.getStatus();
    expect(status.maintenance).toBe(true);
    expect(status.manifest?.stage).not.toBe('DONE');
    expect(status.manifest?.error).toBeTruthy();
    // 清单文件保留（原子替换写入）
    const manifestRaw = await readFile(join(stateDir, 'control-manifest.json'), 'utf8');
    expect(JSON.parse(manifestRaw).restoreUuid).toBe('fail-uuid');
    await rm(stateDir, { recursive: true, force: true });
  });

  it('beginShutdown 后就绪探针立即失败、新投递的恢复管道在阶段边界停止推进（L4）', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wbme-restore-shutdown-'));
    process.env.RESTORE_DRY_RUN = '1';
    process.env.RESTORE_STATE_DIR = stateDir;
    process.env.RECOVERY_SESSION_SECRET = SESSION_SECRET;
    // readiness 要求依赖配置完整（dry-run 不实际连接，无效端口即可）
    process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/nope';
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    // 问题18 修复：就绪检查要求 OSS 配置完整（不连接，仅校验配置存在）
    process.env.OSS_BUCKET = 'test-bucket';
    process.env.OSS_REGION = 'oss-cn-hangzhou';
    const service = new RecoveryExecutorService();
    try {
      // 就绪基线（状态目录可写 + 控制配置完整）
      expect((await service.readiness()).ready).toBe(true);
      // 停机标记 → 就绪立即失败（主 PRD §9.13）
      service.beginShutdown();
      const result = await service.readiness();
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('优雅停机中');
      // 停机后新投递：清单落盘（先写后执行）+ 维护标记保持，但管道在 PRECHECK 阶段边界即停止推进
      await service.acceptDelivery({ restoreUuid: 'shutdown-uuid', backupId: 2 });
      await new Promise((r) => setTimeout(r, 500));
      const status = await service.getStatus();
      expect(status.manifest?.stage).toBe('PRECHECK');
      expect(status.maintenance).toBe(true);
      // 清单文件保留（重启/超管可续跑）
      const manifestRaw = await readFile(join(stateDir, 'control-manifest.json'), 'utf8');
      expect(JSON.parse(manifestRaw).restoreUuid).toBe('shutdown-uuid');
    } finally {
      delete process.env.RECOVERY_SESSION_SECRET;
      delete process.env.DATABASE_URL;
      delete process.env.REDIS_URL;
      delete process.env.OSS_BUCKET;
      delete process.env.OSS_REGION;
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});


describe('acceptDelivery 终态清单语义（批次8复核修复）', () => {
  const doneManifest = (restoreUuid: string): Record<string, unknown> => ({
    restoreUuid,
    backupId: 1,
    stage: 'DONE',
    updatedAt: '2026-08-10T02:00:00.000Z',
  });

  async function seedStateDir(manifest: Record<string, unknown>): Promise<string> {
    const stateDir = await mkdtemp(join(tmpdir(), 'wbme-accept-'));
    await writeFile(join(stateDir, 'control-manifest.json'), JSON.stringify(manifest), 'utf8');
    return stateDir;
  }

  function createService(stateDir: string): RecoveryExecutorService {
    process.env.RESTORE_DRY_RUN = '1';
    process.env.RESTORE_STATE_DIR = stateDir;
    return new RecoveryExecutorService();
  }

  it('DONE 清单 + 同 restoreUuid：幂等忽略，不重跑破坏性管道', async () => {
    const stateDir = await seedStateDir(doneManifest('uuid-a'));
    const service = createService(stateDir);
    try {
      await service.acceptDelivery({ restoreUuid: 'uuid-a', backupId: 1 });
      // 等待足够一轮 dry-run 管道时间：若被重跑，清单会被改写（updatedAt 变化）
      await new Promise((r) => setTimeout(r, 600));
      const raw = await readFile(join(stateDir, 'control-manifest.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual(doneManifest('uuid-a'));
      // 未开始新一轮：不产生归档文件
      await expect(readFile(join(stateDir, 'control-manifest.uuid-a.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('DONE 清单 + 不同 restoreUuid：归档旧清单（保留审计痕迹）并开始新一轮恢复', async () => {
    const stateDir = await seedStateDir(doneManifest('uuid-a'));
    const service = createService(stateDir);
    try {
      await service.acceptDelivery({ restoreUuid: 'uuid-b', backupId: 2 });
      // 旧清单另存归档名保留（按 PRD 不删除）
      const archived = JSON.parse(await readFile(join(stateDir, 'control-manifest.uuid-a.json'), 'utf8'));
      expect(archived).toEqual(doneManifest('uuid-a'));
      // 新清单开始新一轮；dry-run 管道推进到 DONE 并退出维护状态
      await new Promise((r) => setTimeout(r, 900));
      const status = await service.getStatus();
      expect(status.manifest?.restoreUuid).toBe('uuid-b');
      expect(status.manifest?.stage).toBe('DONE');
      expect(status.maintenance).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('进行中清单 + 不同 restoreUuid：拒绝新投递，清单不被覆盖', async () => {
    const inFlight = {
      restoreUuid: 'uuid-a',
      backupId: 1,
      stage: 'RESTORING',
      updatedAt: '2026-08-10T02:00:00.000Z',
    };
    const stateDir = await seedStateDir(inFlight);
    const service = createService(stateDir);
    try {
      await expect(service.acceptDelivery({ restoreUuid: 'uuid-b', backupId: 2 })).rejects.toThrow(
        '已有进行中的恢复',
      );
      const raw = await readFile(join(stateDir, 'control-manifest.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual(inFlight);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('进行中清单 + 同 restoreUuid：忽略重投（既不拒绝也不重跑）', async () => {
    const inFlight = {
      restoreUuid: 'uuid-a',
      backupId: 1,
      stage: 'RESTORING',
      updatedAt: '2026-08-10T02:00:00.000Z',
    };
    const stateDir = await seedStateDir(inFlight);
    const service = createService(stateDir);
    try {
      await service.acceptDelivery({ restoreUuid: 'uuid-a', backupId: 1 });
      const raw = await readFile(join(stateDir, 'control-manifest.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual(inFlight);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('assertBackupObjectEncryption 备份加密预检', () => {
  it('本地替身无加密元数据时跳过校验', () => {
    expect(() => assertBackupObjectEncryption({ usesLocalFallback: true })).not.toThrow();
  });

  it('本地替身即使出现异常加密值也跳过校验', () => {
    expect(() =>
      assertBackupObjectEncryption({ serverSideEncryption: 'none', usesLocalFallback: true }),
    ).not.toThrow();
  });

  it('OSS 场景 AES256 通过', () => {
    expect(() =>
      assertBackupObjectEncryption({ serverSideEncryption: 'AES256', usesLocalFallback: false }),
    ).not.toThrow();
  });

  it('OSS 场景缺失加密元数据时拒绝', () => {
    expect(() =>
      assertBackupObjectEncryption({ usesLocalFallback: false }),
    ).toThrow(/未使用 SSE-OSS\/AES256/);
  });

  it('OSS 场景非 AES256 加密时拒绝', () => {
    expect(() =>
      assertBackupObjectEncryption({ serverSideEncryption: 'KMS', usesLocalFallback: false }),
    ).toThrow(/未使用 SSE-OSS\/AES256/);
  });

  it('未声明存储类型时按 OSS 处理，缺失加密元数据拒绝', () => {
    expect(() => assertBackupObjectEncryption({})).toThrow(/未使用 SSE-OSS\/AES256/);
  });
});
