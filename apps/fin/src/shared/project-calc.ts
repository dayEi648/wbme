import { Prisma, type Project } from '../generated/prisma/client';

/**
 * 利润分析自动字段实时计算（fin PRD §4 / 主 PRD §9.11）。
 *
 * 自动计算字段不落库，由后端基于事务提交后的最新明细实时计算：
 * - 累计开票 = 开票金额求和；累计收款 = 已收回款求和
 * - 剩余未开票 = 暂定/审定金额 − 累计开票；剩余未收款 = 暂定/审定金额 − 累计收款（可负，不截断）
 * - 累计分包付款 = 零星费用 + 已付分包款求和
 * - 暂定保通权益 = 累计收款 − 累计分包付款（可负）
 * - 毛利率 = 暂定保通权益 ÷ 累计收款，至少保留 8 位内部小数；累计收款为 0 时返回 null（前端显示“—”）
 *
 * 金额全程使用 Prisma Decimal（decimal.js）十进制定点计算，禁止 JavaScript number。
 */

/** 明细输入（计算只需要金额字段；顺序即展示/导出顺序） */
export interface ProjectDetailsInput {
  invoices: readonly { amount: Prisma.Decimal }[];
  receipts: readonly { amount: Prisma.Decimal }[];
  subcontractPayments: readonly { amount: Prisma.Decimal }[];
}

/** 自动计算结果（金额为十进制字符串；毛利率为比率字符串或 null=“—”） */
export interface ProjectCalcResult {
  /** 累计开票（元） */
  totalInvoiced: string;
  /** 累计收款（元） */
  totalReceived: string;
  /** 累计分包付款（元） */
  totalSubcontractPaid: string;
  /** 剩余未开票（元；可为负） */
  remainingUninvoiced: string;
  /** 剩余未收款（元；可为负） */
  remainingUnreceived: string;
  /** 暂定保通权益（元；可为负） */
  equity: string;
  /** 毛利率（内部比率 0.25 表示 25%；收款为 0 时为 null） */
  grossMargin: string | null;
}

/** 求和辅助（空数组为 0） */
function sumAmounts(rows: readonly { amount: Prisma.Decimal }[]): Prisma.Decimal {
  return rows.reduce((acc, row) => acc.plus(row.amount), new Prisma.Decimal(0));
}

/** 金额格式化：两位小数（自动计算字段落 API 边界统一字符串） */
function fmt(amount: Prisma.Decimal): string {
  return amount.toFixed(2);
}

/**
 * 计算项目全部自动字段（基于项目主档金额与三类明细实时汇总）。
 *
 * @param project 项目主档（tentativeAuditedAmount / miscExpense 可为 null，按 0 参与计算）
 * @param details 三类金额明细
 * @returns 自动计算结果（金额两位小数；毛利率 null=“—”）
 */
export function calcProjectAutoFields(
  project: Pick<Project, 'tentativeAuditedAmount' | 'miscExpense'>,
  details: ProjectDetailsInput,
): ProjectCalcResult {
  const tentativeAmount = project.tentativeAuditedAmount ?? new Prisma.Decimal(0);
  const miscExpense = project.miscExpense ?? new Prisma.Decimal(0);

  const totalInvoiced = sumAmounts(details.invoices);
  const totalReceived = sumAmounts(details.receipts);
  const totalSubcontractPaid = miscExpense.plus(sumAmounts(details.subcontractPayments));
  const remainingUninvoiced = tentativeAmount.minus(totalInvoiced);
  const remainingUnreceived = tentativeAmount.minus(totalReceived);
  const equity = totalReceived.minus(totalSubcontractPaid);

  // 毛利率：十进制除法并四舍五入到 8 位内部小数（主 PRD §9.11）；收款为 0 不除零
  const grossMargin = totalReceived.isZero()
    ? null
    : equity.div(totalReceived).toDecimalPlaces(8).toFixed();

  return {
    totalInvoiced: fmt(totalInvoiced),
    totalReceived: fmt(totalReceived),
    totalSubcontractPaid: fmt(totalSubcontractPaid),
    remainingUninvoiced: fmt(remainingUninvoiced),
    remainingUnreceived: fmt(remainingUnreceived),
    equity: fmt(equity),
    grossMargin,
  };
}
