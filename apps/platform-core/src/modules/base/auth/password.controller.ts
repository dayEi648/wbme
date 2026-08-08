import { Body, Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { BusinessException, accountErrors } from '@wbme/contracts';
import {
  CurrentUser,
  Public,
  RateLimit,
  RateLimitGuard,
  CSRF_COOKIE,
  FLOW_COOKIE,
  CsrfService,
  csrfCookieOptions,
  flowCookieOptions,
  parseCookies,
} from '@wbme/server';
import type { Request, Response } from 'express';
import { PrismaService } from '../../../prisma.service';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { FlowSessionService } from './flows/flow-session.service';
import { ResetFlow } from './flows/reset.flow';
import { ChangePasswordDto, ResetInitiateDto, ResetPasswordDto } from './dto/password.dto';
import { RedeemTokenDto } from './dto/activation.dto';

/** 会话 Cookie Secure 属性（生产必须 true；本地 http 开发设 false） */
function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE !== 'false';
}

/**
 * 密码接口（base PRD §2/§3）：
 * A9 修改密码（成功后全部会话失效）、A10 钉钉验证式密码重置确认（M2 凭证 + 钉钉授权）。
 * 重置完成前旧会话有效，完成后统一失效（session_version 递增）。
 */
@Controller('auth/password')
export class PasswordController {
  constructor(
    private readonly auth: AuthService,
    private readonly reset: ResetFlow,
    private readonly flows: FlowSessionService,
    private readonly token: TokenService,
    private readonly csrf: CsrfService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** A9 修改密码（登录态） */
  @Post('change')
  async change(
    @CurrentUser() userId: number,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    if (dto.confirmPassword !== dto.newPassword) {
      throw new BusinessException(accountErrors.PASSWORD_CONFIRM_MISMATCH);
    }
    await this.auth.changePassword(userId, dto.currentPassword, dto.newPassword, req.ip ?? 'unknown');
    return { ok: true };
  }

  /**
   * 自助重置发起（A10'，base PRD §2）：已绑定钉钉账号凭手机号发起。
   * 签发重置流程 Cookie（RESET）并返回钉钉授权地址；回调后走 reset/confirm 完成。
   * 账号不存在/未绑定统一提示 RESET_SELF_UNAVAILABLE，不泄露手机号是否注册。
   */
  @Public()
  @Post('reset/initiate')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'reset-initiate', keyType: 'ip', limit: 10, windowSeconds: 60 })
  async resetInitiate(
    @Body() dto: ResetInitiateDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ authorizeUrl: string }> {
    const result = await this.reset.initiateByPhone(dto.phone, req.ip ?? 'unknown');
    const flowId = await this.flows.issue('RESET', { userId: result.userId });
    res.cookie(FLOW_COOKIE, flowId, flowCookieOptions(cookieSecure()));
    res.cookie(CSRF_COOKIE, this.csrf.issue(), csrfCookieOptions(cookieSecure()));
    return { authorizeUrl: '/api/v1/auth/dingtalk/authorize?purpose=RESET' };
  }

  /** 重置凭证兑换（M2 端点：账号 ACTIVE；兑换成功发 Path 限定重置流程 Cookie） */
  @Public()
  @Post('reset/redeem')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'reset-redeem', keyType: 'ip', limit: 10, windowSeconds: 60 })
  async resetRedeem(@Body() dto: RedeemTokenDto, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    const tokenHash = this.token.hash(dto.token);
    const result = await this.reset.redeem(dto.token, tokenHash);
    const flowId = await this.flows.issue('RESET', { userId: result.userId, tokenHash });
    res.cookie(FLOW_COOKIE, flowId, flowCookieOptions(cookieSecure()));
    res.cookie(CSRF_COOKIE, this.csrf.issue(), csrfCookieOptions(cookieSecure()));
    return { user: { id: result.userId, name: result.name } };
  }

  /** A10 重置确认（重置流程 Cookie + 钉钉授权身份；完成后全会话失效） */
  @Public()
  @Post('reset/confirm')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'reset-confirm', keyType: 'ip', limit: 10, windowSeconds: 60 })
  async resetConfirm(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ResetPasswordDto,
  ): Promise<{ ok: true }> {
    if (dto.confirmPassword !== dto.newPassword) {
      throw new BusinessException(accountErrors.PASSWORD_CONFIRM_MISMATCH);
    }
    const flowId = parseCookies(req.headers.cookie)[FLOW_COOKIE];
    if (!flowId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    const flow = await this.flows.assert(flowId, 'RESET');
    if (!flow.unionId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    await this.reset.confirm(
      flowId,
      {
        unionId: flow.unionId,
        mobile: flow.mobile ?? '',
        stateCode: flow.stateCode ?? '',
        newPassword: dto.newPassword,
      },
      req.ip ?? 'unknown',
    );
    // 流程会话已消费，清除一次性流程 Cookie（base PRD §7.3：确认成功后即删）
    res.clearCookie(FLOW_COOKIE, { path: '/api/v1/auth' });
    return { ok: true };
  }
}
