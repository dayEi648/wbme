import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from './session-constants';
import { CsrfService } from './csrf.service';
import { parseCookies } from './cookie';

/**
 * CSRF 守卫（主 PRD §9.7）：双提交 Cookie + 自定义头。
 *
 * - 只对非 GET/HEAD/OPTIONS 且携带会话 Cookie 的请求校验（状态变更请求）；
 * - 要求 X-WBME-CSRF-Token 头与 wbme_csrf Cookie 一致且签名有效；
 * - 钉钉回调（GET）豁免：其 CSRF 风险由一次性 state 承担；
 * - 登录等公开 POST 无会话 Cookie，跳过本守卫（登录接口风险由限流与统一错误承担）。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(CsrfService) private readonly csrf: CsrfService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return true;
    }
    // 未挂 cookie-parser 时从原始头解析（与 SessionGuard 一致）
    const cookies = parseCookies(request.headers.cookie);
    const hasSessionCookie = Boolean(cookies[SESSION_COOKIE]);
    if (!hasSessionCookie) {
      // 无会话 Cookie 的公开写请求（登录等）由限流承担风险，不做 CSRF 校验
      return true;
    }
    const headerValue = request.headers[CSRF_HEADER];
    const csrfHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!this.csrf.verify(cookies[CSRF_COOKIE], csrfHeader)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
