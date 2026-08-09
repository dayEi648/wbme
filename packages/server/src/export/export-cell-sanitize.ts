/**
 * 对用户文本单元格做公式注入防护：以 = + - @ 开头时前缀单引号。
 *
 * @param value 原始值
 */
export function sanitizeExportCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value);
  if (/^[=+\-@]/.test(text)) {
    return `'${text}`;
  }
  return text;
}
