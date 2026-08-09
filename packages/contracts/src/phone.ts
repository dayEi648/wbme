/**
 * 手机号规范化与脱敏（base PRD §2、主 PRD §9.3）。
 *
 * 平台标准存储格式：`+{国家码}{号码}`（如 `+8613800138000`），只含数字与前置 `+`；
 * 写入、唯一性校验与登录查询前统一规范化，避免 `+86`、空格、连字符等表现差异造成
 * 重复账号或同步误判；显示时再按前端规则格式化。
 */

/** 平台默认国家码（业务时区固定中国，主 PRD §9.10） */
export const DEFAULT_COUNTRY_CODE = '86';

/** 规范化后的平台标准手机号正则：`+CC` + 纯数字，号码 5~15 位 */
const NORMALIZED_PHONE_PATTERN = /^\+(\d{1,3})(\d{5,15})$/;

/** 手机号脱敏展示格式：保留国家码与前 3 后 4，中间以 **** 掩蔽 */
export function maskPhone(normalized: string): string {
  // 中国（唯一实际场景）固定 +86 匹配，避免国家码贪婪吞位（861 vs 86）
  const cn = /^\+86(\d{5,15})$/.exec(normalized);
  if (cn?.[1]) {
    return `+86 ${cn[1].slice(0, 3)}****${cn[1].slice(-4)}`;
  }
  // 其它国家码兜底
  const generic = /^\+(\d{1,3})(\d{5,15})$/.exec(normalized);
  if (generic?.[1] && generic[2]) {
    return `+${generic[1]} ${generic[2].slice(0, 3)}****${generic[2].slice(-4)}`;
  }
  // 非标准格式不泄露，统一返回脱敏兜底
  return '***';
}

/**
 * 校验并规范化钉钉等外部来源的手机号（国家码 + 号码分开传入）。
 * @param stateCode 国家码（如 `86` / `+86` / `0086`，可为空则用默认）
 * @param mobile    号码（可含空格/连字符/括号）
 * @returns 平台标准格式；号码缺失或格式非法返回 null
 */
export function normalizePhoneFromParts(stateCode: string | null | undefined, mobile: string): string | null {
  const digits = stripPhoneDigits(mobile);
  if (digits.length === 0) {
    return null;
  }
  const cc = cleanCountryCode(stateCode ?? DEFAULT_COUNTRY_CODE);
  if (!cc) {
    return null;
  }
  const normalized = `+${cc}${digits}`;
  return NORMALIZED_PHONE_PATTERN.test(normalized) ? normalized : null;
}

/**
 * 规范化用户输入的手机号（登录/注册表单）。
 * 支持：`13800138000`（默认国家码）、`+8613800138000`、`8613800138000`、
 * `008613800138000`，以及其中夹杂空格/连字符/括号的写法。
 * @param raw 原始输入
 * @returns 平台标准格式；无法解析返回 null
 */
export function normalizePhoneInput(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned) {
    return null;
  }
  // 提取可能的国家码前缀：+86 / 0086 / 86（当号码长于 11 位时按国家码处理）
  let number = stripPhoneDigits(cleaned);
  let countryCode = DEFAULT_COUNTRY_CODE;

  if (number.startsWith('0086')) {
    countryCode = '86';
    number = number.slice(4);
  } else if (number.startsWith('86') && number.length > 11) {
    countryCode = '86';
    number = number.slice(2);
  } else if (cleaned.startsWith('+')) {
    const match = /^\+(\d{1,3})\s*(\d[\d\s-]*)$/.exec(cleaned);
    if (!match) {
      return null;
    }
    countryCode = match[1] ?? '';
    number = stripPhoneDigits(match[2] ?? '');
  }
  if (!countryCode || number.length === 0) {
    return null;
  }
  const normalized = `+${countryCode}${number}`;
  return NORMALIZED_PHONE_PATTERN.test(normalized) ? normalized : null;
}

/** 判断字符串是否为规范化后的平台标准手机号 */
export function isNormalizedPhone(value: string): boolean {
  return NORMALIZED_PHONE_PATTERN.test(value);
}

/** 清理号码中所有非数字字符 */
function stripPhoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** 规范化国家码：去空格、`+` 前缀与 `00` 前缀 */
function cleanCountryCode(value: string): string {
  let cc = value.replace(/\s+/g, '');
  if (cc.startsWith('+')) {
    cc = cc.slice(1);
  } else if (cc.startsWith('00')) {
    cc = cc.slice(2);
  }
  return /^\d{1,3}$/.test(cc) ? cc : '';
}
