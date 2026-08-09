import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { validateHolidayResponse } from './holiday.validator';

/**
 * 节假日响应严格校验单测（T6-4）。
 * golden 数据为 2026-08-09 对 holiday.ailcc.com 的实测响应。
 */

/** 实测：2026-01-01 元旦（法定节假日，wage=3） */
const statutoryHoliday = JSON.stringify({
  code: 0,
  type: { type: 2, name: '元旦节（休）', week: 4 },
  holiday: { holiday: true, name: '元旦节（休）', wage: 3, date: '2026-01-01' },
});

/** 实测：2026-01-02 元旦放假第 2 天（调休放假，wage=2） */
const adjustedHoliday = JSON.stringify({
  code: 0,
  type: { type: 2, name: '元旦节（休）', week: 5 },
  holiday: { holiday: true, name: '元旦节（休）', wage: 2, date: '2026-01-02' },
});

/** 实测：2026-01-04 周日补班（wage=1, holiday=false） */
const makeupWorkday = JSON.stringify({
  code: 0,
  type: { type: 4, name: '元旦节（班）', week: 7 },
  holiday: { holiday: false, name: '元旦节（班）', wage: 1, date: '2026-01-04', after: 1, target: '元旦节' },
});

/** 实测：2026-08-09 普通周日（周末，wage=2） */
const normalWeekend = JSON.stringify({
  code: 0,
  type: { type: 1, name: '周日', week: 7 },
  holiday: { holiday: true, name: '周日', wage: 2, date: '2026-08-09' },
});

/** 实测：2026-08-10 普通周一（工作日，holiday=null） */
const normalWorkday = JSON.stringify({
  code: 0,
  type: { type: 0, name: '周一', week: 1 },
  holiday: null,
});

const FIXED_NOW = '2026-08-09T00:00:00.000Z';

describe('节假日响应校验（T6-4）', () => {
  it('法定节假日 wage=3 → HOLIDAY', () => {
    const result = validateHolidayResponse(statutoryHoliday, '2026-01-01', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.dateType).toBe('HOLIDAY');
      expect(result.normalized.weekday).toBe(4);
      expect(result.normalized.source).toBe('ailcc');
      expect(result.normalized.digest).toHaveLength(64);
      expect(result.rawDigest).toBe(result.normalized.digest);
    }
  });

  it('调休放假 wage=2 → ADJUSTED_HOLIDAY', () => {
    const result = validateHolidayResponse(adjustedHoliday, '2026-01-02', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.dateType).toBe('ADJUSTED_HOLIDAY');
      expect(result.normalized.weekday).toBe(5);
    }
  });

  it('补班日 wage=1 → ADJUSTED_WORKDAY', () => {
    const result = validateHolidayResponse(makeupWorkday, '2026-01-04', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.dateType).toBe('ADJUSTED_WORKDAY');
    }
  });

  it('普通周末 → WEEKEND', () => {
    const result = validateHolidayResponse(normalWeekend, '2026-08-09', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.dateType).toBe('WEEKEND');
    }
  });

  it('普通工作日 → WORKDAY', () => {
    const result = validateHolidayResponse(normalWorkday, '2026-08-10', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.dateType).toBe('WORKDAY');
      expect(result.normalized.weekday).toBe(1);
    }
  });

  it('供应商错误码（code!=0）拒绝', () => {
    const result = validateHolidayResponse(JSON.stringify({ code: 1001, msg: '日期格式错误' }), '2026-01-01', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(false);
  });

  it('非 JSON 响应拒绝', () => {
    const result = validateHolidayResponse('<html>error</html>', '2026-01-01', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(false);
  });

  it('响应日期与请求日期不一致拒绝（非法输入返回错配数据的实测安全点）', () => {
    const mismatched = JSON.stringify({
      code: 0,
      type: { type: 1, name: '周日', week: 7 },
      holiday: { holiday: true, name: '周日', wage: 2, date: '2026-08-09' },
    });
    const result = validateHolidayResponse(mismatched, 'not-a-date', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(false);
  });

  it('星期值与请求日期不一致拒绝', () => {
    const wrongWeek = JSON.stringify({
      code: 0,
      type: { type: 0, name: '周一', week: 3 },
      holiday: null,
    });
    const result = validateHolidayResponse(wrongWeek, '2026-08-10', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(false);
  });

  it('工作日响应携带 holiday 对象拒绝（语义矛盾）', () => {
    const contradictory = JSON.stringify({
      code: 0,
      type: { type: 0, name: '周一', week: 1 },
      holiday: { holiday: true, wage: 2, date: '2026-08-10' },
    });
    const result = validateHolidayResponse(contradictory, '2026-08-10', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(false);
  });

  it('周末 wage 非 2 拒绝（补班语义矛盾）', () => {
    const contradictory = JSON.stringify({
      code: 0,
      type: { type: 1, name: '周日', week: 7 },
      holiday: { holiday: true, name: '周日', wage: 1, date: '2026-08-09' },
    });
    const result = validateHolidayResponse(contradictory, '2026-08-09', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(false);
  });

  it('未知日期类型 type=3 拒绝（宁可降级不误判）', () => {
    const unknownType = JSON.stringify({
      code: 0,
      type: { type: 3, name: '未知', week: 7 },
      holiday: { holiday: true, wage: 2, date: '2026-08-09' },
    });
    const result = validateHolidayResponse(unknownType, '2026-08-09', 'ailcc', FIXED_NOW);
    expect(result.ok).toBe(false);
  });
});
