import { describe, expect, it } from 'vitest';
import { getTaskProcessor } from './index';
import { TASK_TYPE_ACCOUNT_LIFECYCLE } from '@wbme/tasks';

describe('getTaskProcessor', () => {
  it('返回已知任务类型处理器', () => {
    const processor = getTaskProcessor(TASK_TYPE_ACCOUNT_LIFECYCLE);
    expect(typeof processor).toBe('function');
  });

  it('未知类型抛出', () => {
    expect(() => getTaskProcessor('UNKNOWN' as never)).toThrow('未知后台任务类型');
  });
});
