import { describe, expect, it } from 'vitest';
import { beijingDateString, beijingHour, isPastScheduledBackupBoundary } from './beijing-time';

describe('beijing-time', () => {
  it('格式化北京时间日期', () => {
    const date = new Date('2026-08-09T01:30:00.000Z');
    expect(beijingDateString(date)).toBe('2026-08-09');
  });

  it('判断 02:00 备份边界', () => {
    const before = new Date('2026-08-09T01:30:00.000+08:00');
    const after = new Date('2026-08-09T02:30:00.000+08:00');
    expect(beijingHour(before)).toBe(1);
    expect(isPastScheduledBackupBoundary(before)).toBe(false);
    expect(beijingHour(after)).toBe(2);
    expect(isPastScheduledBackupBoundary(after)).toBe(true);
  });
});
