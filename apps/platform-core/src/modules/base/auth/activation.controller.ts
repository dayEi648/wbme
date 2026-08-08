import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
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
  flowCookieOptions,
  parseCookies,
  sessionCookieOptions,
} from '@wbme/server';
import type { Request, Response } from 'express';
import { FlowSessionService } from './flows/flow-session.service';
import { ActivationFlow } from './flows/activation.flow';
import { ConfirmProfileDto, RedeemTokenDto } from './dto/activation.dto';

/** 会话 Cookie Secure 属性（生产必须 true；本地 http 开发设 false） */
function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE !== 'false';
}

/**
 * 激活接口（base PRD §2，T2-2）：
 * A6 凭证兑换（发 Path 限定一次性流程 Cookie）、A7 激活确认（单事务完成 + 自动登录）。
 * 凭证只在 A6 请求体出现一次，后续步骤由流程 Cookie 承接。
 */
@ApiTags('激活与注册')
@Controller('auth/activation')
export class ActivationController {
  constructor(
    private readonly activation: ActivationFlow,
    private readonly flows: FlowSessionService,
    private readonly csrf: CsrfService,
  ) {}

  /** A6 兑换一次性激活凭证（公开；按 IP 与凭证前缀限流） */
  @Public()
  @Post('redeem')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'redeem', keyType: 'ip', limit: 10, windowSeconds: 60 })
  async redeem(
    @Body() dto: RedeemTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.activation.redeem(dto.token);
    // 兑换成功 → 一次性流程 Cookie（覆盖钉钉授权/回调与激活流程）+ CSRF Cookie（确认请求双提交）
    const flowId = await this.flows.issue('ACTIVATION', { userId: result.userId, tokenHash: result.tokenHash });
    res.cookie(FLOW_COOKIE, flowId, flowCookieOptions(cookieSecure()));
    res.cookie(CSRF_COOKIE, this.csrf.issue(), csrfCookieOptions(cookieSecure()));
    return { user: { id: result.userId, name: result.name, phoneMasked: result.phoneMasked } };
  }

  /** A7 激活确认（公开；流程 Cookie；姓名/性别/密码 + 钉钉授权身份） */
  @Public()
  @Post('confirm')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'activation-confirm', keyType: 'ip', limit: 10, windowSeconds: 60 })
  async confirm(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ConfirmProfileDto,
  ): Promise<unknown> {
    if (dto.confirmPassword !== dto.password) {
      throw new BusinessException(accountErrors.PASSWORD_CONFIRM_MISMATCH);
    }
    const flowId = this.readFlowCookie(req);
    if (!flowId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    // unionId 由钉钉回调写入流程会话（A5 ACTIVATION 分支）
    const flow = await this.flows.assert(flowId, 'ACTIVATION');
    if (!flow.unionId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    const result = await this.activation.confirm(
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

  private readFlowCookie(req: Request): string | undefined {
    return parseCookies(req.headers.cookie)[FLOW_COOKIE];
  }
}
