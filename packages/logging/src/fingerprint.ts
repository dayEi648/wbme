import { createHash } from 'node:crypto';

/**
 * 规范化请求/指纹负载：对象键排序、数组逐项规范化后按序列化结果排序。
 *
 * @param value 待规范化值
 * @returns 规范化后的值（用于稳定 JSON 序列化）
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, canonicalize(item)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * 计算规范化负载的 SHA-256 十六进制指纹。
 *
 * @param payload 校验后的规范化负载
 * @returns 64 位十六进制指纹
 */
export function fingerprintPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}
