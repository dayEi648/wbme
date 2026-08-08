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
 * 一次性流程 Cookie：Path 仅覆盖对应流程路由（如 /api/v1/auth/activation）。
 * 凭证只在兑换请求体出现一次，兑换成功后由流程 Cookie 承接后续步骤。
 */
export function flowCookieOptions(secure: boolean, flowPathPrefix: string): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: flowPathPrefix,
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
