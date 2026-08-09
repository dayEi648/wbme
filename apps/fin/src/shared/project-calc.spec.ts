import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { calcProjectAutoFields } from './project-calc';

/** 构造明细行（三表同构） */
function detail(amount: string, occurredDate: Date | null = null): { amount: Prisma.Decimal; occurredDate: Date | null; remark: string | null } {
  return { amount: new Prisma.Decimal(amount), occurredDate, remark: null };
}

function makeProject(overrides: { tentativeAuditedAmount?: string | null; miscExpense?: string | null } = {}): { tentativeAuditedAmount: Prisma.Decimal | null; miscExpense: Prisma.Decimal | null } {
  return {
    tentativeAuditedAmount: overrides.tentativeAuditedAmount === undefined ? null : overrides.tentativeAuditedAmount === null ? null : new Prisma.Decimal(overrides.tentativeAuditedAmount),
    miscExpense: overrides.miscExpense === undefined ? null : overrides.miscExpense === null ? null : new Prisma.Decimal(overrides.miscExpense),
  };
}

/**
 * 自动字段实时计算（fin PRD §4 / 主 PRD §9.11）：
 * 全程 Decimal 十进制定点，不使用 JavaScript number；可负结果不截断；
 * 毛利率至少 8 位内部小数，收款为零返回 null（显示“—”）。
 */
describe('calcProjectAutoFields（自动字段实时计算）', () => {
  it('全空项目：自动金额为 0，毛利率 null', () => {
    const result = calcProjectAutoFields(makeProject(), { invoices: [], receipts: [], subcontractPayments: [] });
    expect(result.totalInvoiced).toBe('0.00');
    expect(result.totalReceived).toBe('0.00');
    expect(result.totalSubcontractPaid).toBe('0.00');
    expect(result.remainingUninvoiced).toBe('0.00');
    expect(result.remainingUnreceived).toBe('0.00');
    expect(result.equity).toBe('0.00');
    expect(result.grossMargin).toBeNull();
  });

  it('明细求和与剩余金额（含真实负数不截断）', () => {
    const result = calcProjectAutoFields(makeProject({ tentativeAuditedAmount: '1000.00', miscExpense: '100.00' }), {
      invoices: [detail('200.00'), detail('150.50')],
      receipts: [detail('100.00')],
      subcontractPayments: [detail('50.00'), detail('25.25')],
    });
    expect(result.totalInvoiced).toBe('350.50');
    expect(result.totalReceived).toBe('100.00');
    expect(result.totalSubcontractPaid).toBe('175.25'); // 零星 100 + 分包 75.25
    expect(result.remainingUninvoiced).toBe('649.50'); // 1000 - 350.50
    expect(result.remainingUnreceived).toBe('900.00'); // 1000 - 100
    expect(result.equity).toBe('-75.25'); // 100 - 175.25（真实负数）
  });

  it('未填写的暂定金额按 0 参与计算', () => {
    const result = calcProjectAutoFields(makeProject(), {
      invoices: [detail('500.00')],
      receipts: [],
      subcontractPayments: [],
    });
    expect(result.remainingUninvoiced).toBe('-500.00');
    expect(result.remainingUnreceived).toBe('0.00');
  });

  it('毛利率 = 权益 ÷ 累计收款，保留 8 位内部小数（0.25 → 25%）', () => {
    const result = calcProjectAutoFields(makeProject({ miscExpense: '0' }), {
      invoices: [],
      receipts: [detail('400.00')],
      subcontractPayments: [detail('300.00')],
    });
    expect(result.grossMargin).toBe('0.25');
  });

  it('毛利率小数除法按高精度（如 1/3）', () => {
    const result = calcProjectAutoFields(makeProject({ miscExpense: '0' }), {
      invoices: [],
      receipts: [detail('300.00')],
      subcontractPayments: [detail('100.00')],
    });
    expect(result.grossMargin).toBe('0.66666667'); // 200/300 四舍五入到 8 位
  });

  it('累计收款为零 → 毛利率 null（不除零）', () => {
    const result = calcProjectAutoFields(makeProject(), {
      invoices: [detail('100.00')],
      receipts: [],
      subcontractPayments: [detail('50.00')],
    });
    expect(result.grossMargin).toBeNull();
  });

  it('两位小数精度汇总（Decimal 定点不出现浮点误差）', () => {
    const result = calcProjectAutoFields(makeProject({ tentativeAuditedAmount: '0.10' }), {
      invoices: [detail('0.10'), detail('0.20')],
      receipts: [detail('0.30')],
      subcontractPayments: [detail('0.10')],
    });
    expect(result.totalInvoiced).toBe('0.30');
    expect(result.totalReceived).toBe('0.30');
  });
});
