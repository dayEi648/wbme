import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Inject, Query, Req, Res, UseGuards } from '@nestjs/common';
import { BusinessException, accountErrors, normalizePhoneFromParts } from '@wbme/contracts';
import {
  Public,
  RateLimit,
  RateLimitGuard,
  CSRF_COOKIE,
  FLOW_COOKIE,
  SESSION_COOKIE,
  csrfCookieOptions,
  flowCookieOptions,
  sessionCookieOptions,
  parseCookies,
} from '@wbme/server';
import type { Request, Response } from 'express';
import { PrismaService } from '../../../prisma.service';
import { AuthService } from '../auth/auth.service';
import { FlowSessionService } from '../auth/flows/flow-session.service';
import { DINGTALK_GATEWAY, DingtalkNotMemberError, DingtalkUnavailableError, type DingtalkGateway } from './dingtalk.gateway';
import { DingtalkGatewayImpl } from './dingtalk.gateway.impl';
import { DINGTALK_PURPOSES, DingtalkStateService, type DingtalkPurpose } from './dingtalk.state.service';

/** 会话 Cookie Secure 属性（生产必须 true；本地 http 开发设 false） */
function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE !== 'false';
}

/** 前端公开地址（回调 302 与链接生成基准 origin） */
function publicOrigin(): string {
  return process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173';
}

/** 钉钉回调地址（与开发者后台一致；须指向后端 /api/v1 路由，经前端/Nginx 代理转发） */
function dingtalkRedirectUri(): string {
  return process.env.DINGTALK_REDIRECT_URI ?? `${publicOrigin()}/api/v1/auth/dingtalk/callback`;
}

/**
 * 钉钉 OAuth 扫码授权（base PRD §2）：
 * A4 授权发起（服务端签名 URL + 一次性 state）、A5 回调（校验后按用途分流）。
 * 回调为浏览器 302 跳转：成功跳前端对应页面，失败跳 /login?error={code}。
 */
@ApiTags('钉钉 OAuth')
@Controller('auth/dingtalk')
export class DingtalkController {
  constructor(
    @Inject(DINGTALK_GATEWAY) private readonly gateway: DingtalkGateway,
    private readonly state: DingtalkStateService,
    private readonly flows: FlowSessionService,
    private readonly auth: AuthService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** A4 授权发起：返回钉钉授权 URL（含一次性 state） */
  @Public()
  @Get('authorize')
  @UseGuards(RateLimitGuard)
  // 三维限流（base PRD §4）：IP / 会话（流程 Cookie）/ 一次性状态值（state 由服务端签发，不在此计数）
  @RateLimit({ scope: 'dingtalk-authorize', keyType: 'ip', limit: 30, windowSeconds: 60 })
  @RateLimit({ scope: 'dingtalk-authorize-flow', keyType: 'cookie', keyName: 'wbme_flow', limit: 10, windowSeconds: 60 })
  async authorize(
    @Query('purpose') purposeRaw: string,
    @Req() req: Request,
  ): Promise<{ authorizeUrl: string }> {
    const purpose = this.resolvePurpose(purposeRaw);
    // 流程类用途（激活/重置）必须持有对应的一次性流程 Cookie（兑换或发起时签发）；
    // 流程标识随一次性 state 交给钉钉回调（base PRD §2：回调只携带 state/nonce 和流程标识，
    // 不依赖流程 Cookie 覆盖钉钉路径）
    let flowId: string | undefined;
    if (purpose === 'ACTIVATION' || purpose === 'RESET') {
      flowId = this.readCookie(req, FLOW_COOKIE);
      const flow = await this.flows.read(flowId ?? '', purpose);
      if (!flow) {
        throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
      }
    }
    const impl = this.gateway as DingtalkGatewayImpl;
    if (!impl.isConfigured?.()) {
      throw new BusinessException(accountErrors.DINGTALK_CONFIG_MISSING);
    }
    const state = await this.state.issue(purpose, flowId);
    return { authorizeUrl: this.gateway.buildAuthorizeUrl({ state, redirectUri: dingtalkRedirectUri() }) };
  }

  /** A5 钉钉回调（公开 GET；CSRF 风险由一次性 state 承担） */
  @Public()
  @Get('callback')
  @UseGuards(RateLimitGuard)
  // 三维限流（base PRD §4）：IP / 会话（流程 Cookie）/ 一次性状态值（query state）
  @RateLimit({ scope: 'dingtalk-callback', keyType: 'ip', limit: 60, windowSeconds: 60 })
  @RateLimit({ scope: 'dingtalk-callback-state', keyType: 'query', keyName: 'state', limit: 5, windowSeconds: 60 })
  @RateLimit({ scope: 'dingtalk-callback-flow', keyType: 'cookie', keyName: 'wbme_flow', limit: 5, windowSeconds: 60 })
  async callback(
    @Query('code') code: string,
    @Query('state') stateRaw: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ip = req.ip ?? 'unknown';
    try {
      // 一次性 state 校验（取用即删）
      const stateData = await this.state.consume(stateRaw);
      const purpose = stateData.purpose;

      // 授权码兑换 + 组织校验（corpId 与部署配置一致；配置了公司组织时缺失/不一致均拒绝）
      const token = await this.gateway.exchangeCodeForUserToken(code);
      const configuredCorpId = process.env.DINGTALK_CORP_ID;
      if (configuredCorpId && token.corpId !== configuredCorpId) {
        throw new BusinessException(accountErrors.DINGTALK_ORG_MISMATCH);
      }
      const info = await this.gateway.getUserInfo(token.accessToken);
      const member = await this.gateway.getOrgMemberByUnionId(info.unionId);
      if (!member.active) {
        throw new BusinessException(accountErrors.DINGTALK_ORG_MISMATCH);
      }

      // 手机号（userinfo 优先，组织成员接口兜底）
      const mobile = info.mobile || member.mobile;
      const stateCode = info.stateCode || member.stateCode;

      // 按用途分流
      if (purpose === 'LOGIN') {
        await this.handleLoginFlow(res, req, { unionId: info.unionId, mobile, stateCode }, ip);
        return;
      }
      if (purpose === 'REGISTRATION') {
        // 扫码注册：绑定身份校验（unionId 未绑定 + 手机号未占用）后进入完善页
        await this.ensureRegistrable(info.unionId, mobile, stateCode);
        const flowId = await this.flows.issue('REGISTRATION', { unionId: info.unionId, mobile, stateCode });
        this.setFlowCookie(res, 'REGISTRATION', flowId);
        this.redirect(res, '/register');
        return;
      }
      if (purpose === 'ACTIVATION' || purpose === 'RESET') {
        // 流程标识由一次性 state 携带（回调请求路径不在流程 Cookie 的 Path 范围内），
        // 回调后把钉钉身份（含手机号）写入流程会话
        const flowId = stateData.flowId;
        const flow = await this.flows.assert(flowId ?? '', purpose);
        await this.flows.update(flowId ?? '', { ...flow, unionId: info.unionId, mobile, stateCode });
        const target = purpose === 'ACTIVATION' ? '/activate/complete' : '/reset-password/complete';
        this.redirect(res, target);
        return;
      }
      this.redirect(res, '/login?error=DINGTALK_STATE_INVALID');
    } catch (error) {
      if (error instanceof BusinessException) {
        this.redirect(res, `/login?error=${error.entry.code}`);
        return;
      }
      // 钉钉明确确认非本组织成员：提示"当前钉钉账号不属于本公司组织"（base PRD §2）
      if (error instanceof DingtalkNotMemberError) {
        this.redirect(res, '/login?error=DINGTALK_ORG_MISMATCH');
        return;
      }
      if (error instanceof DingtalkUnavailableError) {
        this.redirect(res, '/login?error=DEPENDENCY_UNAVAILABLE');
        return;
      }
      this.redirect(res, '/login?error=SYSTEM');
    }
  }

  /** 扫码登录/注册分流（A5 LOGIN） */
  private async handleLoginFlow(
    res: Response,
    req: Request,
    info: { unionId: string; mobile: string; stateCode: string },
    ip: string,
  ): Promise<void> {
    const result = await this.auth.loginWithDingtalk(info, ip);
    if (result) {
      // 扫码登录无"记住我"选项（非记住我会话，Cookie 为浏览器会话级）
      res.cookie(
        SESSION_COOKIE,
        result.sessionId,
        sessionCookieOptions(cookieSecure(), result.rememberMe ? result.absTimeoutSeconds : undefined),
      );
      res.cookie(CSRF_COOKIE, result.csrfToken, csrfCookieOptions(cookieSecure()));
      this.redirect(res, '/portal');
      return;
    }
    // 未绑定：手机号占用检查后进入扫码注册完善页（手机号取自本次钉钉授权结果，随流程会话保存）
    await this.ensureRegistrable(info.unionId, info.mobile, info.stateCode);
    const flowId = await this.flows.issue('REGISTRATION', { unionId: info.unionId, mobile: info.mobile, stateCode: info.stateCode });
    this.setFlowCookie(res, 'REGISTRATION', flowId);
    this.redirect(res, '/register');
  }

  /** 扫码注册前置校验：unionId 未绑定 + 手机号未占用（base PRD §2） */
  private async ensureRegistrable(unionId: string, mobile: string, stateCode: string): Promise<void> {
    if (!mobile) {
      throw new BusinessException(accountErrors.PHONE_MISSING_FROM_DINGTALK);
    }
    // 钉钉稳定标识全局唯一（含已注销/已解绑历史，base PRD §2：注销后仍占用）
    const bound = await this.prisma.client.dingtalkBinding.findFirst({
      where: { dingtalkUnionId: unionId },
      select: { id: true },
    });
    if (bound) {
      throw new BusinessException(accountErrors.DINGTALK_ALREADY_BOUND);
    }
    // 手机号占用：待激活/正常账号（注销为历史快照不占用）
    const normalized = normalizePhoneFromParts(stateCode, mobile);
    if (normalized) {
      const pending = await this.prisma.client.user.findFirst({
        where: { phone: normalized, deletedAt: null, status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] } },
        select: { status: true },
      });
      if (pending) {
        throw new BusinessException(
          pending.status === 'PENDING_ACTIVATION' ? accountErrors.PENDING_ACCOUNT_EXISTS : accountErrors.PHONE_TAKEN,
        );
      }
    }
  }

  private setFlowCookie(res: Response, _purpose: string, flowId: string): void {
    res.cookie(FLOW_COOKIE, flowId, flowCookieOptions(cookieSecure()));
  }

  private redirect(res: Response, path: string): void {
    res.redirect(302, `${publicOrigin()}${path}`);
  }

  private readCookie(req: Request, name: string): string | undefined {
    return parseCookies(req.headers.cookie)[name];
  }

  private resolvePurpose(raw: string): DingtalkPurpose {
    if ((DINGTALK_PURPOSES as readonly string[]).includes(raw)) {
      return raw as DingtalkPurpose;
    }
    throw new BusinessException(accountErrors.DINGTALK_STATE_INVALID);
  }
}

export { DingtalkPurpose };
