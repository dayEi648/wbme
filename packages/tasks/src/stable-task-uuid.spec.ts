import { describe, expect, it } from 'vitest';
import { stableTaskUuid, TASK_TYPE_ACCOUNT_LIFECYCLE } from './index';

describe('stableTaskUuid', () => {
  it('同一业务键生成确定性 UUID', () => {
    const key = `${TASK_TYPE_ACCOUNT_LIFECYCLE}:DEACTIVATED:42:3`;
    const a = stableTaskUuid(key);
    const b = stableTaskUuid(key);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('不同业务键生成不同 UUID', () => {
    const a = stableTaskUuid('A:1');
    const b = stableTaskUuid('A:2');
    expect(a).not.toBe(b);
  });
});
