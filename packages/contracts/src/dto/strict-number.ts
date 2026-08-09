/**
 * 正整数严格解析（asset PRD §5：不接受小数、零、负数、科学计数法或非数值文本）。
 *
 * - 字符串仅接受 /^\d+$/ 纯数字文本（"1e2"、"1.5"、"0"、"-1"、"" 等一律拒绝）；
 * - 数字须为大于 0 的整数；
 * - 其余类型（undefined 之外的 null/数组/对象）拒绝。
 * 与 @IsInt + @Min(1) 并用（本工具负责文本形态拒绝，校验器负责类型兜底）。
 */
export function transformPositiveInt({ value }: { value: unknown }): number {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new Error('数量必须是不含小数/科学计数法的正整数');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error('数量必须是不含小数/科学计数法的正整数');
    }
    return parsed;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error('数量必须是不含小数/科学计数法的正整数');
    }
    return value;
  }
  throw new Error('数量必须是不含小数/科学计数法的正整数');
}
