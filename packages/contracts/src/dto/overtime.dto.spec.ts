import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { OvertimeManageQueryDto, OvertimeMineQueryDto, OvertimeSummaryQueryDto, MONTH_PATTERN } from './overtime.dto';

describe('overtime 月份参数校验（L14：拒绝非法月份静默进位）', () => {
  it('MONTH_PATTERN 收紧：仅接受 01–12', () => {
    expect(MONTH_PATTERN.test('2026-01')).toBe(true);
    expect(MONTH_PATTERN.test('2026-12')).toBe(true);
    expect(MONTH_PATTERN.test('2026-13')).toBe(false);
    expect(MONTH_PATTERN.test('2026-00')).toBe(false);
    expect(MONTH_PATTERN.test('2026-1')).toBe(false);
    expect(MONTH_PATTERN.test('2026-08')).toBe(true);
  });

  it('带 month 的查询 DTO：2026-13 在 DTO 层即被拒绝（不再 Date.UTC 进位到 2027-01）', async () => {
    for (const Dto of [OvertimeMineQueryDto, OvertimeSummaryQueryDto, OvertimeManageQueryDto]) {
      const invalid = new Dto();
      (invalid as { month?: string }).month = '2026-13';
      const errors = await validate(invalid);
      expect(errors.some((error) => error.property === 'month')).toBe(true);
    }
  });

  it('合法月份通过校验', async () => {
    const dto = new OvertimeSummaryQueryDto();
    dto.month = '2026-08';
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'month')).toBe(false);
  });
});
