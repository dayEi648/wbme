import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  Public,
  RateLimit,
  RateLimitGuard,
  SESSION_COOKIE,
  CSRF_COOKIE,
  sessionCookieOptions,
  csrfCookieOptions,
  clearCookie,
} from '@wbme/server';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginPasswordDto } from './dto/login.dto';

/** 会话 Cookie Secure 属性（生产必须 true；本地 http 开发设 false） */
function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE !== 'false';
}

/**
 * 认证接口（base PRD §2/§3/§4）：
 * A1 密码登录、A2 登出、A3 当前身份。
 * 登录成功下发会话 Cookie + CSRF 双提交 Cookie。
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** A1 手机号 + 密码登录（公开；IP 与手机号双维限流） */
  @Public()
  @Post('login/password')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'login', keyType: 'ip', limit: 20, windowSeconds: 60 })
  @RateLimit({ scope: 'login', keyType: 'raw', key: 'phone', limit: 10, windowSeconds: 60 })
  async login(
    @Body() dto: LoginPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const ip = req.ip ?? 'unknown';
    const result = await this.auth.loginPassword(dto, ip);
    res.cookie(SESSION_COOKIE, result.sessionId, sessionCookieOptions(cookieSecure()));
    res.cookie(CSRF_COOKIE, result.csrfToken, csrfCookieOptions(cookieSecure()));
    return {
      user: result.user,
      sessionExpiresAt: result.sessionExpiresAt,
    };
  }

  /** A2 登出（登录态；删会话 + LOGOUT 安全日志 + 清 Cookie） */
  @Post('logout')
  async logout(
    @CurrentUser() userId: number,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const sessionId = this.readSessionId(req);
    if (sessionId) {
      await this.auth.logout(sessionId, userId, req.ip ?? 'unknown');
    }
    clearCookie(res, SESSION_COOKIE);
    clearCookie(res, CSRF_COOKIE);
    return { ok: true };
  }

  /** A3 当前身份（登录态） */
  @Get('me')
  async me(@CurrentUser() userId: number): Promise<unknown> {
    return this.auth.me(userId);
  }

  private readSessionId(req: Request): string | undefined {
    const header = req.headers.cookie;
    if (!header) {
      return undefined;
    }
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE) {
        return decodeURIComponent(part.slice(index + 1).trim());
      }
    }
    return undefined;
  }
}
