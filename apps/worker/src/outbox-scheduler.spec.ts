import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OutboxScheduler } from './outbox-scheduler';
import {
  TASK_MAX_ATTEMPTS,
  TASK_TYPE_RESTORE_DELIVERY,
  TASK_TYPE_SCHEDULED_BACKUP,
  claimOutboxBatch,
  failTimedOutTasks,
  markQueued,
  releaseEnqueueLease,
} from '@wbme/tasks';

vi.mock('@wbme/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wbme/tasks')>();
  return {
    ...actual,
    claimOutboxBatch: vi.fn(async () => []),
    failTimedOutTasks: vi.fn(async () => 0),
    markQueued: vi.fn(async () => true),
    releaseEnqueueLease: vi.fn(async () => true),
    insertPendingTaskSql: vi.fn(async () => ({ taskUuid: 'u', created: false })),
    isPastScheduledBackupBoundary: vi.fn(() => false),
    beijingHour: vi.fn(() => 0),
  };
});

vi.mock('@wbme/server', () => ({
  isMaintenanceActive: vi.fn(async () => false),
  REDIS_NAMESPACE: { QUEUE: 'test-queue' },
  readDiskStatus: vi.fn(async () => ({ status: 'OK' })),
}));

describe('OutboxScheduler maintenance gate', () => {
  it('维护标记存在时不创建或投递新任务', async () => {
    const sql = { query: vi.fn(), queryRows: vi.fn(), transaction: vi.fn() };
    const queue = { add: vi.fn() };
    const scheduler = new OutboxScheduler(sql as never, queue as never, 'scheduler-test', async () => true);

    await scheduler.tick();

    expect(sql.query).not.toHaveBeenCalled();
    expect(sql.queryRows).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('维护标记读取失败时同样不创建或投递新任务', async () => {
    const sql = { query: vi.fn(), queryRows: vi.fn(), transaction: vi.fn() };
    const queue = { add: vi.fn() };
    const scheduler = new OutboxScheduler(sql as never, queue as never, 'scheduler-test', async () => {
      throw new Error('EIO');
    });

    await scheduler.tick();

    expect(sql.query).not.toHaveBeenCalled();
    expect(sql.queryRows).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('OutboxScheduler 投递循环（批次8复核修复）', () => {
  const sql = { query: vi.fn(), queryRows: vi.fn(), transaction: vi.fn() };

  function createScheduler() {
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, _opts: Record<string, unknown>) => ({})),
      remove: vi.fn(async (_jobId: string) => 1),
    };
    const scheduler = new OutboxScheduler(sql as never, queue as never, 'scheduler-test', async () => false);
    return { queue, scheduler };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(failTimedOutTasks).mockResolvedValue(0);
    vi.mocked(markQueued).mockResolvedValue(true);
  });

  it('租约重领的 RUNNING 残留行：先删除同 jobId 残留 job 再投递，RESTORE_DELIVERY 有限重试', async () => {
    vi.mocked(claimOutboxBatch).mockResolvedValue([
      { taskUuid: 't-restore', taskType: TASK_TYPE_RESTORE_DELIVERY, status: 'RUNNING' },
    ]);
    const { queue, scheduler } = createScheduler();

    await scheduler.tick();

    // 先 remove 残留（消除 BullMQ 同 jobId 去重静默丢弃），再 add
    expect(queue.remove).toHaveBeenCalledWith('t-restore');
    expect(queue.add).toHaveBeenCalledOnce();
    expect(queue.remove.mock.invocationCallOrder[0]).toBeLessThan(queue.add.mock.invocationCallOrder[0]!);
    const [name, data, opts] = queue.add.mock.calls[0]!;
    expect(name).toBe(TASK_TYPE_RESTORE_DELIVERY);
    expect(data).toEqual({ taskUuid: 't-restore' });
    expect(opts).toMatchObject({
      jobId: 't-restore',
      attempts: 3,
      backoff: { type: 'exponential' },
    });
    // 投递成功后归队（重领行由 markQueued 扩展 SQL 覆盖）
    expect(markQueued).toHaveBeenCalledWith(sql, 't-restore', 'scheduler-test');
  });

  it('PENDING_ENQUEUE 首投行：不删残留，按默认重试选项投递', async () => {
    vi.mocked(claimOutboxBatch).mockResolvedValue([
      { taskUuid: 't-backup', taskType: TASK_TYPE_SCHEDULED_BACKUP, status: 'PENDING_ENQUEUE' },
    ]);
    const { queue, scheduler } = createScheduler();

    await scheduler.tick();

    expect(queue.remove).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledOnce();
    const [, , opts] = queue.add.mock.calls[0]!;
    expect(opts).toMatchObject({ jobId: 't-backup', attempts: TASK_MAX_ATTEMPTS });
  });

  it('残留 job 仍被旧 Worker 持锁（remove 返回 0）：放弃本轮投递并记录，等下周期重试', async () => {
    vi.mocked(claimOutboxBatch).mockResolvedValue([
      { taskUuid: 't-restore', taskType: TASK_TYPE_RESTORE_DELIVERY, status: 'RUNNING' },
    ]);
    const { queue, scheduler } = createScheduler();
    queue.remove.mockResolvedValue(0);

    await scheduler.tick();

    expect(queue.add).not.toHaveBeenCalled();
    expect(releaseEnqueueLease).toHaveBeenCalledWith(
      sql,
      't-restore',
      'scheduler-test',
      0,
      expect.stringContaining('残留 job'),
      expect.any(Date),
    );
  });

  it('投递异常（queue.add 失败）：释放投递租约并记录错误（既有语义不变）', async () => {
    vi.mocked(claimOutboxBatch).mockResolvedValue([
      { taskUuid: 't-backup', taskType: TASK_TYPE_SCHEDULED_BACKUP, status: 'PENDING_ENQUEUE' },
    ]);
    const { queue, scheduler } = createScheduler();
    queue.add.mockRejectedValue(new Error('redis down'));

    await scheduler.tick();

    expect(releaseEnqueueLease).toHaveBeenCalledWith(
      sql,
      't-backup',
      'scheduler-test',
      0,
      'redis down',
      expect.any(Date),
    );
  });
});
