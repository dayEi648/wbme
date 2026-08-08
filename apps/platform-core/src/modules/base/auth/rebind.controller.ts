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
import { SecurityLogService } from '../security-log/security-log.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { FlowSessionService } from './flows/flow-session.service';
import { RebindFlow } from './flows/rebind.flow';
import { SelfRebindDto } from './dto/password.dto';
import { RedeemTokenDto } from './dto/activation.dto';

/** 会话 Cookie Secure 属性（生产必须 true；本地 http 开发设 false） */
function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE !== 'false';
}

/**
 * 钉钉换绑接口（base PRD §2、backstage PRD §3）：
 * A12 自助换绑发起（验证平台密码）、M3 换绑凭证兑换、A11 换绑确认（原子替换绑定）。
 * 旧绑定在新身份全部校验通过前继续有效；换绑成功后全部会话失效。
 */
@Controller('auth/rebind')
export class RebindController {
  constructor(
    private readonly rebind: RebindFlow,
    private readonly password: PasswordService,
    private readonly flows: FlowSessionService,
    private readonly token: TokenService,
    private readonly csrf: CsrfService,
    private readonly securityLog: SecurityLogService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** A12 自助换绑发起（登录态：校验平台密码后签发换绑流程 Cookie 并返回钉钉授权 URL 由前端发起） */
  @Post('self-initiate')
  async selfInitiate(
    @CurrentUser() userId: number,
    @Body() dto: SelfRebindDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ authorizeUrl: string }> {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    const ok = await this.password.verifyPassword(dto.password, user?.passwordHash ?? '');
    if (!ok) {
      throw new BusinessException(accountErrors.OLD_PASSWORD_INCORRECT);
    }
    // 需已有有效绑定才能换绑（无绑定时拒绝）
    const binding = await this.prisma.client.dingtalkBinding.findFirst({
      where: { userId, status: 'BOUND' },
      select: { id: true },
    });
    if (!binding) {
      throw new BusinessException(accountErrors.BINDING_NOT_FOUND);
    }
    const flowId = await this.flows.issue('REBIND', { userId, verifiedFlags: ['OLD_IDENTITY_VERIFIED'] });
    res.cookie(FLOW_COOKIE, flowId, flowCookieOptions(cookieSecure()));
    await this.securityLog.record('BINDING_CHANGED_ISSUED', 'SUCCESS', { actorId: userId, sourceIp: req.ip ?? 'unknown' });
    res.cookie(CSRF_COOKIE, this.csrf.issue(), csrfCookieOptions(cookieSecure()));
    // 前端凭流程 Cookie 调 A4(purpose=REBIND) 获取钉钉授权 URL（同源相对路径，经 /api/v1 代理）
    return { authorizeUrl: `/api/v1/auth/dingtalk/authorize?purpose=REBIND` };
  }

  /** M3 换绑凭证兑换（超管代发；兑换成功发 Path 限定换绑流程 Cookie） */
  @Public()
  @Post('redeem')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'rebind-redeem', keyType: 'ip', limit: 10, windowSeconds: 60 })
  async redeem(@Body() dto: RedeemTokenDto, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    const tokenHash = this.token.hash(dto.token);
    const result = await this.rebind.redeem(dto.token, tokenHash);
    const flowId = await this.flows.issue('REBIND', { userId: result.userId });
    res.cookie(FLOW_COOKIE, flowId, flowCookieOptions(cookieSecure()));
    res.cookie(CSRF_COOKIE, this.csrf.issue(), csrfCookieOptions(cookieSecure()));
    return { user: { id: result.userId, name: result.name } };
  }

  /** A11 换绑确认（换绑流程 Cookie + 钉钉授权身份；原子替换 + 手机号同步 + 全会话失效） */
  @Public()
  @Post('confirm')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'rebind-confirm', keyType: 'ip', limit: 10, windowSeconds: 60 })
  async confirm(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const flowId = parseCookies(req.headers.cookie)[FLOW_COOKIE];
    if (!flowId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    const flow = await this.flows.assert(flowId, 'REBIND');
    if (!flow.unionId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    await this.rebind.confirm(
      flowId,
      { unionId: flow.unionId, mobile: flow.mobile ?? '', stateCode: flow.stateCode ?? '' },
      req.ip ?? 'unknown',
    );
    // 流程会话已消费，清除一次性流程 Cookie（base PRD §7.3：确认成功后即删）
    res.clearCookie(FLOW_COOKIE, { path: '/api/v1/auth' });
    return { ok: true };
  }
}

