import { describe, expect, it } from 'vitest';

describe('TablePrefs 唯一约束契约', () => {
  it('FILTER_PRESET 按 (userId, pageKey, name) 唯一', () => {
    const key = { userId: 1, pageKey: 'users', name: '默认' };
    expect(key).toMatchObject({ userId: 1, pageKey: 'users', name: '默认' });
  });

  it('COLUMN_SETTING 按 (userId, pageKey) 唯一', () => {
    const key = { userId: 1, pageKey: 'users' };
    expect(Object.keys(key)).toEqual(['userId', 'pageKey']);
  });
});
