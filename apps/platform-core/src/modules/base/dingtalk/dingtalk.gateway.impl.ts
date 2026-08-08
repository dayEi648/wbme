import { Injectable, Logger } from '@nestjs/common';
import {
  DingtalkNotMemberError,
  DingtalkUnavailableError,
  type DingtalkGateway,
  type DingtalkOrgMember,
  type DingtalkUserInfo,
} from './dingtalk.gateway';

/**
 * 钉钉官方 OAuth2 网页扫码登录实现（base PRD §2，2026-08 官方流程）。
 *
 * - 授权页：login.dingtalk.io/oauth2/auth（企业内部应用；域名历史有 .com/.io 两种表述，集中常量可配）；
 * - 授权码 → userAccessToken（含用户所选组织 corpId，组织校验依据）；
 * - userinfo 取 unionId/openId/nick/mobile/stateCode；
 * - 组织成员校验：corpId 与部署配置一致 且 组织成员接口成功且 active；
 * - 钉钉超时/不可用抛 DingtalkUnavailableError（映射 DEPENDENCY_UNAVAILABLE），
 *   不得误报组织不匹配、不得跳过校验；
 * - 凭证只在后端使用，不下发前端、不写入日志。
 */
@Injectable()
export class DingtalkGatewayImpl implements DingtalkGateway {
  private readonly logger = new Logger(DingtalkGatewayImpl.name);

  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly corpId: string;

  /** 应用级令牌内存缓存（有效期前 60s 刷新） */
  private appTokenCache: { token: string; expiresAt: number } | null = null;

  /** 网关超时（毫秒） */
  private static readonly TIMEOUT_MS = 5_000;

  /** 请求超时（钉钉不可用时快速失败，映射依赖不可用） */
  private static readonly REQUEST_TIMEOUT = DingtalkGatewayImpl.TIMEOUT_MS;

  constructor() {
    this.appKey = process.env.DINGTALK_APP_KEY ?? '';
    this.appSecret = process.env.DINGTALK_APP_SECRET ?? '';
    this.corpId = process.env.DINGTALK_CORP_ID ?? '';
  }

  /** 钉钉是否已配置（未配置时授权入口返回 DINGTALK_CONFIG_MISSING） */
  isConfigured(): boolean {
    return Boolean(this.appKey && this.appSecret && this.corpId);
  }

  buildAuthorizeUrl(params: { state: string; redirectUri: string }): string {
    const search = new URLSearchParams({
      redirect_uri: params.redirectUri,
      response_type: 'code',
      client_id: this.appKey,
      // openid corpid：获取用户 id 及所选组织 id（corpId 必传，scope 含 corpid 时）
      scope: 'openid corpid',
      prompt: 'consent',
      state: params.state,
      corpId: this.corpId,
    });
    return `https://login.dingtalk.io/oauth2/auth?${search.toString()}`;
  }

  async exchangeCodeForUserToken(code: string): Promise<{ accessToken: string; corpId: string }> {
    const body = await this.request<{ accessToken: string; corpId: string }>('https://api.dingtalk.io/v1.0/oauth2/userAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: this.appKey,
        clientSecret: this.appSecret,
        code,
        grantType: 'authorization_code',
      }),
    });
    if (!body.accessToken) {
      throw new DingtalkUnavailableError('钉钉授权码兑换失败（无 accessToken）');
    }
    return { accessToken: body.accessToken, corpId: body.corpId ?? '' };
  }

  async getUserInfo(userToken: string): Promise<DingtalkUserInfo> {
    const info = await this.request<{
      unionId?: string;
      openId?: string;
      mobile?: string;
      stateCode?: string;
      nick?: string;
    }>('https://api.dingtalk.io/v1.0/oauth2/userinfo', {
      headers: { 'x-acs-dingtalk-access-token': userToken },
    });
    if (!info.unionId) {
      throw new DingtalkUnavailableError('钉钉用户信息缺少 unionId');
    }
    return {
      unionId: info.unionId,
      openId: info.openId ?? '',
      mobile: info.mobile ?? '',
      stateCode: info.stateCode ?? '',
      nick: info.nick ?? '',
    };
  }

  async getOrgMemberByUnionId(unionId: string): Promise<DingtalkOrgMember> {
    const appToken = await this.getAppAccessToken();
    const member = await this.request<{
      unionId?: string;
      mobile?: string;
      stateCode?: string;
      active?: boolean;
      departmentIds?: number[];
    }>(`https://api.dingtalk.io/v1.0/contact/users/${encodeURIComponent(unionId)}`, {
      headers: { 'x-acs-dingtalk-access-token': appToken },
    }, { notMemberStatuses: [401, 403, 404] });
    if (!member.unionId) {
      // 用户不属于本公司组织（接口按组织上下文查询，非本组织返回错误或空）
      throw new DingtalkNotMemberError('钉钉组织成员查询未返回该成员');
    }
    return {
      unionId: member.unionId,
      mobile: member.mobile ?? '',
      stateCode: member.stateCode ?? '',
      active: member.active !== false,
      departmentIds: member.departmentIds ?? [],
    };
  }

  /** 应用级令牌（有内存缓存；过期前 60s 刷新） */
  private async getAppAccessToken(): Promise<string> {
    if (this.appTokenCache && Date.now() < this.appTokenCache.expiresAt - 60_000) {
      return this.appTokenCache.token;
    }
    const body = await this.request<{ accessToken?: string; expireIn?: number }>(
      'https://api.dingtalk.io/v1.0/oauth2/accessToken',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appKey: this.appKey, appSecret: this.appSecret }),
      },
    );
    if (!body.accessToken) {
      throw new DingtalkUnavailableError('钉钉应用令牌获取失败');
    }
    this.appTokenCache = { token: body.accessToken, expiresAt: Date.now() + (body.expireIn ?? 7200) * 1000 };
    return body.accessToken;
  }

  /**
   * 统一请求：超时、5xx 与网络错误按"依赖不可用"处理；
   * 显式声明的业务性拒绝状态码（如成员查询的 401/403/404）按"非本组织成员"处理
   * （base PRD §2：组织不匹配提示"不属于本公司组织"，不得误报依赖不可用）。
   */
  private async request<T>(url: string, init: RequestInit, opts: { notMemberStatuses?: number[] } = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DingtalkGatewayImpl.REQUEST_TIMEOUT);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        if (opts.notMemberStatuses?.includes(response.status)) {
          throw new DingtalkNotMemberError(`钉钉接口业务性拒绝（HTTP ${response.status}）`);
        }
        throw new DingtalkUnavailableError(`钉钉接口响应异常（HTTP ${response.status}）`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof DingtalkUnavailableError || error instanceof DingtalkNotMemberError) {
        throw error;
      }
      const aborted = error instanceof Error && error.name === 'AbortError';
      this.logger.warn(`钉钉网关调用失败（${aborted ? '超时' : '连接失败'}）: ${url}`);
      throw new DingtalkUnavailableError(aborted ? '钉钉网关超时' : '钉钉网关不可达', error);
    } finally {
      clearTimeout(timer);
    }
  }
}
