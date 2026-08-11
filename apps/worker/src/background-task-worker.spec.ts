import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BackgroundTaskRow } from '@wbme/tasks';
import { claimRunning, loadTaskByUuid, markFailed, markSucceeded } from '@wbme/tasks';
import { upsertErrorLog } from '@wbme/logging';
import { getTaskProcessor } from './processors';
import { BackgroundTaskWorker, LeaseNotClaimableError } from './background-task-worker';

/** 捕获 BullMQ Worker 处理器（vi.mock 工厂被提升，需经 vi.hoisted 共享） */
const captured = vi.hoisted(() => ({
  processFn: null as null | ((job: unknown) => Promise<void>),
}));

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(_name: string, processFn: (job: unknown) => Promise<void>) {
      captured.processFn = processFn;
    }
    on(): void {}
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

vi.mock('@wbme/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wbme/tasks')>();
  return {
    ...actual,
    loadTaskByUuid: vi.fn(),
    claimRunning: vi.fn(),
    renewRunningLease: vi.fn(async () => true),
    markSucceeded: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
  };
});

vi.mock('@wbme/logging', () => ({
  bucketStart: vi.fn((date: Date) => date),
  computeErrorFingerprint: vi.fn(() => 'fingerprint'),
  upsertErrorLog: vi.fn(async () => true),
}));

vi.mock('@wbme/server', () => ({
  REDIS_NAMESPACE: { QUEUE: 'test-queue' },
}));

vi.mock('./processors', () => ({
  getTaskProcessor: vi.fn(),
}));

/** 构造 Worker 并返回捕获到的 BullMQ 任务处理器 */
function createWorkerProcessFn(): (job: unknown) => Promise<void> {
  const worker = new BackgroundTaskWorker('redis://127.0.0.1:6379', {} as never, {} as never, 'worker-1', 'commit-test');
  worker.start();
  if (!captured.processFn) {
    throw new Error('BullMQ Worker 处理器未被捕获');
  }
  return captured.processFn;
}

function fakeJob(taskUuid: string, opts: { attempts: number; attemptsMade: number }): unknown {
  return {
    id: taskUuid,
    data: { taskUuid },
    opts: { attempts: opts.attempts },
    attemptsMade: opts.attemptsMade,
  };
}

function taskRow(taskUuid: string): BackgroundTaskRow {
  return {
    taskUuid,
    taskType: 'RESTORE_DELIVERY',
    module: 'backstage',
    initiatorId: null,
    initiatorType: 'SCHEDULER',
    ref: { restoreUuid: 'r-1', backupId: 1 },
    status: 'QUEUED',
    progress: 0,
    attempts: 0,
  };
}

describe('BackgroundTaskWorker.handleJob 租约语义（批次8复核修复）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('租约暂不可领：抛出 LeaseNotClaimableError 交由 BullMQ 重试，不标 FAILED、不写错误日志', async () => {
    vi.mocked(loadTaskByUuid).mockResolvedValue(taskRow('t-1'));
    vi.mocked(claimRunning).mockResolvedValue(false);
    const processFn = createWorkerProcessFn();
    // 即便已是最后一次 BullMQ 尝试，也不得按真执行失败终态化任务行
    const job = fakeJob('t-1', { attempts: 1, attemptsMade: 0 });

    await expect(processFn(job)).rejects.toBeInstanceOf(LeaseNotClaimableError);
    expect(markFailed).not.toHaveBeenCalled();
    expect(upsertErrorLog).not.toHaveBeenCalled();
    expect(getTaskProcessor).not.toHaveBeenCalled();
  });

  it('真执行失败且最后一次尝试：标记 FAILED 并写集中错误日志（既有语义不变）', async () => {
    vi.mocked(loadTaskByUuid).mockResolvedValue(taskRow('t-2'));
    vi.mocked(claimRunning).mockResolvedValue(true);
    vi.mocked(getTaskProcessor).mockReturnValue(async () => {
      throw new Error('exec boom');
    });
    const processFn = createWorkerProcessFn();
    const job = fakeJob('t-2', { attempts: 1, attemptsMade: 0 });

    await expect(processFn(job)).rejects.toThrow('exec boom');
    expect(markFailed).toHaveBeenCalledWith({}, 't-2', 'worker-1', 'exec boom');
    expect(upsertErrorLog).toHaveBeenCalledOnce();
  });

  it('执行成功：领取租约并标记成功', async () => {
    vi.mocked(loadTaskByUuid).mockResolvedValue(taskRow('t-3'));
    vi.mocked(claimRunning).mockResolvedValue(true);
    vi.mocked(getTaskProcessor).mockReturnValue(async () => undefined);
    const processFn = createWorkerProcessFn();
    const job = fakeJob('t-3', { attempts: 3, attemptsMade: 0 });

    await processFn(job);

    expect(markSucceeded).toHaveBeenCalledWith({}, 't-3', 'worker-1');
    expect(markFailed).not.toHaveBeenCalled();
  });
});
