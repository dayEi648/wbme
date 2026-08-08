import type { Response } from 'express';
import type { CookieOptions } from 'express';

/**
 * 会话与流程 Cookie 统一写入/解析（主 PRD §9.7）。
 *
 * - 会话 Cookie：HttpOnly + Secure（按部署配置）+ SameSite=Lax + Path=/；
 * - CSRF Cookie：非 HttpOnly（前端读取）双提交；
 * - 流程 Cookie：HttpOnly + Secure + SameSite=Lax + Path 限定对应流程。
 */

/** 会话 Cookie 基础属性 */
export function sessionCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  };
}

/** CSRF 双提交 Cookie：必须非 HttpOnly 供前端读取 */
export function csrfCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
  };
}

/**
 * 一次性流程 Cookie：Path 覆盖 /api/v1/auth 前缀。
 * 钉钉授权发起/回调（/api/v1/auth/dingtalk/*）与各流程路由
 * （/api/v1/auth/activation|registration|password/reset|rebind）统一可达；
 * 流程标识在回调侧随一次性 state 携带（base PRD §2），Cookie 仅作流程持有凭证。
 */
export function flowCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/api/v1/auth',
  };
}

/** 解析请求 Cookie（express 已支持 req.cookies，此函数供无 cookie-parser 的场景兜底） */
export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) {
    return result;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      result[key] = decodeURIComponent(value);
    }
  }
  return result;
}

/** 清除 Cookie（登出/流程结束） */
export function clearCookie(res: Response, name: string, path = '/'): void {
  res.clearCookie(name, { path });
}
