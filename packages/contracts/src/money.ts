/**
 * 金额与比率传输约定（主 PRD §9.11）。
 *
 * - 人民币金额统一 PostgreSQL `numeric(18,2)`、Prisma `Decimal`，禁止 JavaScript `number` 计算；
 * - REST DTO 金额使用规范化十进制字符串（如 "1234.50"），只允许最多两位小数；
 * - 手工输入的金额与单价必须 ≥ 0（允许 0）；自动计算字段按业务公式可得到负数；
 * - 毛利率内部以十进制比率表达（`0.25` 表示 25%），至少保留 8 位内部小数。
 */

/** REST DTO 中金额的十进制字符串类型 */
export type AmountString = string;

/** REST DTO 中比率的十进制字符串类型（如 "0.25"） */
export type RatioString = string;

/** 非负金额格式：最多两位小数（手工输入金额契约，主 PRD §9.11） */
const NON_NEGATIVE_AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

/** 任意金额格式：允许负数（自动计算结果，如剩余未开票） */
const SIGNED_AMOUNT_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

/**
 * 校验非负金额字符串（手工输入金额契约）。
 * @param value 十进制字符串；空字符串视为未填写（非金额）
 * @returns 是否为合法非负金额（最多两位小数）
 */
export function isNonNegativeAmount(value: string): boolean {
  return NON_NEGATIVE_AMOUNT_PATTERN.test(value);
}

/**
 * 校验任意金额字符串（允许负数，用于自动计算结果与导入校验）。
 * @param value 十进制字符串
 * @returns 是否为合法金额（最多两位小数，允许负号）
 */
export function isSignedAmount(value: string): boolean {
  return SIGNED_AMOUNT_PATTERN.test(value);
}

/**
 * 校验比率字符串：合法十进制数（可含小数，无位数上限约定由调用方控制）。
 * @param value 十进制字符串
 * @returns 是否为合法十进制比率
 */
export function isRatioString(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}
