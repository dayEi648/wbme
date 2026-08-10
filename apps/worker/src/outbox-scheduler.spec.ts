import { describe, expect, it, vi } from 'vitest';
import { OutboxScheduler } from './outbox-scheduler';

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
