import { ApiTags } from '@nestjs/swagger';
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
@ApiTags('认证与会话')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * A1 手机号 + 密码登录（公开；IP 限流）。
   * 防爆破由登录保护承担：账号锁（按账号连续失败）+ IP 锁（按来源 IP 窗口累计），
   * 参数全部读系统设置（base PRD §4）；此处仅做来源 IP 节流。
   */
  @Public()
  @Post('login/password')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'login', keyType: 'ip', limit: 20, windowSeconds: 60 })
  async login(
    @Body() dto: LoginPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const ip = req.ip ?? 'unknown';
    const result = await this.auth.loginPassword(dto, ip);
    // "记住我"：Cookie 与服务端绝对过期时限一致持久化（浏览器重启保留；不取消绝对过期，base PRD §3）
    res.cookie(
      SESSION_COOKIE,
      result.sessionId,
      sessionCookieOptions(cookieSecure(), result.rememberMe ? result.absTimeoutSeconds : undefined),
    );
    // CSRF 双提交 Cookie 与会话 Cookie 同生命周期："记住我"时持久化（浏览器重启后写请求仍可携带 CSRF 头），
    // 未勾选时浏览器会话级（重启后需重新登录，CSRF 同步失效）
    res.cookie(
      CSRF_COOKIE,
      result.csrfToken,
      csrfCookieOptions(cookieSecure(), result.rememberMe ? result.absTimeoutSeconds : undefined),
    );
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
