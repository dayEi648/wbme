import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { BusinessException, accountErrors } from '@wbme/contracts';
import {
  Public,
  RateLimit,
  RateLimitGuard,
  CSRF_COOKIE,
  FLOW_COOKIE,
  SESSION_COOKIE,
  CsrfService,
  csrfCookieOptions,
  parseCookies,
  sessionCookieOptions,
} from '@wbme/server';
import type { Request, Response } from 'express';
import { FlowSessionService } from './flows/flow-session.service';
import { RegistrationFlow } from './flows/registration.flow';
import { ConfirmProfileDto } from './dto/activation.dto';

/** 会话 Cookie Secure 属性（生产必须 true；本地 http 开发设 false） */
function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE !== 'false';
}

/**
 * 扫码注册接口（base PRD §2，T2-2）：
 * A8 注册确认（流程 Cookie；手机号取自钉钉授权结果只读展示，确认姓名/性别/密码后
 * 单事务创建账号 + 绑定钉钉 + 自动登录）。
 */
@Controller('auth/registration')
export class RegistrationController {
  constructor(
    private readonly registration: RegistrationFlow,
    private readonly flows: FlowSessionService,
    private readonly csrf: CsrfService,
  ) {}

  /** 注册上下文（流程 Cookie）：只读展示钉钉授权返回的手机号（base PRD §2） */
  @Public()
  @Get('context')
  async context(@Req() req: Request): Promise<{ phone: string }> {
    const flowId = parseCookies(req.headers.cookie)[FLOW_COOKIE];
    if (!flowId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    const flow = await this.flows.assert(flowId, 'REGISTRATION');
    if (!flow.mobile) {
      throw new BusinessException(accountErrors.PHONE_MISSING_FROM_DINGTALK);
    }
    return { phone: `+${flow.stateCode ?? '86'} ${flow.mobile}` };
  }

  /** A8 注册确认（流程 Cookie；IP 限流） */
  @Public()
  @Post('confirm')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'registration-confirm', keyType: 'ip', limit: 10, windowSeconds: 60 })
  async confirm(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ConfirmProfileDto,
  ): Promise<unknown> {
    if (dto.confirmPassword !== dto.password) {
      throw new BusinessException(accountErrors.INVALID_CREDENTIALS);
    }
    const flowId = parseCookies(req.headers.cookie)[FLOW_COOKIE];
    if (!flowId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    const flow = await this.flows.assert(flowId, 'REGISTRATION');
    if (!flow.unionId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    const result = await this.registration.confirm(
      flowId,
      {
        unionId: flow.unionId,
        mobile: flow.mobile ?? '',
        stateCode: flow.stateCode ?? '',
        name: dto.name,
        gender: dto.gender,
        password: dto.password,
      },
      req.ip ?? 'unknown',
    );
    res.cookie(SESSION_COOKIE, result.sessionId, sessionCookieOptions(cookieSecure()));
    res.cookie(CSRF_COOKIE, result.csrfToken, csrfCookieOptions(cookieSecure()));
    res.clearCookie(FLOW_COOKIE, { path: '/api/v1/auth' });
    return { user: result.user, sessionExpiresAt: result.sessionExpiresAt };
  }
}
