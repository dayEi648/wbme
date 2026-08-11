import { describe, expect, it, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { FileStorageService } from './file-storage';
import { LocalFileStorage } from './local-storage';
import { LOCAL_OSS_ROOT } from './constants';

/** 每个用例独立的临时本地替身存储 */
const tempRoots: string[] = [];

async function createTempStorage(): Promise<{ rootDir: string; service: FileStorageService }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'wbme-files-'));
  tempRoots.push(rootDir);
  const service = new FileStorageService(null, new LocalFileStorage(rootDir));
  return { rootDir, service };
}

function objectPath(rootDir: string, key: string): string {
  return join(rootDir, LOCAL_OSS_ROOT, key);
}

/** 带 2s 超时包裹的 outcome 探测：悬挂时返回 'hanging' 而非干净 resolve/reject */
async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      (error: Error) => `rejected:${error.message}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('hanging'), 2_000)),
  ]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('presignBackupUpload 流式上传', () => {
  const meta = {
    taskType: 'SCHEDULED' as const,
    backupTime: '2026-08-11T02:00:00.000Z',
    pgVersion: '18.4',
    size: 0,
  };

  it('成功路径：上传与 SHA-256 并行，上传成功后写入清单', async () => {
    const { rootDir, service } = await createTempStorage();
    const chunks = [Buffer.alloc(64 * 1024, 1), Buffer.alloc(64 * 1024, 2), Buffer.from('tail')];
    const payload = Buffer.concat(chunks);
    const result = await service.presignBackupUpload(1, Readable.from(chunks), {
      ...meta,
      size: payload.length,
    });

    const checksum = createHash('sha256').update(payload).digest('hex');
    expect(result).toEqual({
      objectKey: 'backups/1/dump.fc',
      manifestKey: 'backups/1/manifest.json',
      checksum,
    });
    // 备份内容与清单均已落盘（清单含校验和，恢复端据此校验完整性）
    expect(await readFile(objectPath(rootDir, 'backups/1/dump.fc'))).toEqual(payload);
    const manifest = JSON.parse(await readFile(objectPath(rootDir, 'backups/1/manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      backupId: 1,
      taskType: 'SCHEDULED',
      backupTime: meta.backupTime,
      size: payload.length,
      checksum,
      pgVersion: '18.4',
      objectKey: 'backups/1/dump.fc',
    });
  });

  it('上传消费方中途失败：干净 reject 不悬挂、源流被停止、清单不写入', async () => {
    const { rootDir, service } = await createTempStorage();
    // 模拟网络中断：上传方消费一块数据后失败
    vi.spyOn(service, 'putObjectStream').mockImplementation(async (_key, stream) => {
      const iterator = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
      await iterator.next();
      throw new Error('network down');
    });
    const chunks = Array.from({ length: 8 }, (_, i) => Buffer.alloc(64 * 1024, i));
    const source = Readable.from(chunks);

    const outcome = await outcomeOf(
      service.presignBackupUpload(2, source, { ...meta, size: 8 * 64 * 1024 }),
    );

    expect(outcome).toBe('rejected:network down');
    // tee 被销毁后源流经 pipeline 停止（不继续读盘/占 fd）；pipeline 清理在下一拍完成
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.destroyed).toBe(true);
    // 清单语义不变：上传未成功不写入清单
    await expect(readFile(objectPath(rootDir, 'backups/2/manifest.json'), 'utf8')).rejects.toThrow();
  });

  it('源流中途错误：干净 reject 不悬挂、上传消费方随之失败、清单不写入', async () => {
    const { rootDir, service } = await createTempStorage();
    const uploadSpy = vi.spyOn(service, 'putObjectStream');
    const source = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('disk read fail'));
      },
    });

    const outcome = await outcomeOf(service.presignBackupUpload(3, source, { ...meta, size: 7 }));

    expect(outcome).toBe('rejected:disk read fail');
    expect(uploadSpy).toHaveBeenCalledOnce();
    // 源流错误经 tee 传播：本地上传写入方被销毁，不落完整对象；清单不写入
    await expect(readFile(objectPath(rootDir, 'backups/3/manifest.json'), 'utf8')).rejects.toThrow();
  });
});
