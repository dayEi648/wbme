import { describe, expect, it } from 'vitest';
import { generateApplicationNo } from './application-no';

describe('generateApplicationNo', () => {
  it('前缀 + UTC 时间戳 + 3 位随机', () => {
    const now = new Date('2026-08-09T12:34:56.000Z');
    const no = generateApplicationNo('PC', now);
    expect(no).toMatch(/^PC20260809123456\d{3}$/);
  });
});
