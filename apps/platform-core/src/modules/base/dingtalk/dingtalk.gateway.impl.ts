import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  type DingtalkDirectoryMember,
  DingtalkNotMemberError,
  DingtalkUnavailableError,
  type DingtalkGateway,
  type DingtalkOrgMember,
  type DingtalkUserInfo,
} from './dingtalk.gateway';
import { DingtalkConfigService, type DingtalkOAuthCredentials } from './dingtalk-config.service';

/**
 * 钉钉官方 OAuth2 网页扫码登录实现（base PRD §2，2026-08 官方流程）。
 *
 * - 授权页：login.dingtalk.com/oauth2/auth（企业内部应用；域名集中于下方常量，调整只改此处）；
 * - 授权码 → userAccessToken（含用户所选组织 corpId，组织校验依据）；
 * - userinfo 取 unionId/openId/nick/mobile/stateCode；
 * - 组织成员校验：corpId 与部署配置一致 且 组织成员接口成功且 active；
 * - 钉钉超时/不可用抛 DingtalkUnavailableError（映射 DEPENDENCY_UNAVAILABLE），
 *   不得误报组织不匹配、不得跳过校验；
 * - 凭证只在后端使用，不下发前端、不写入日志。
 */

/** 钉钉授权页与开放 API 域名（如钉钉域名调整只改此处） */
const DINGTALK_LOGIN_BASE = 'https://login.dingtalk.com/oauth2/auth';
const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const DINGTALK_LEGACY_API_BASE = 'https://oapi.dingtalk.com';
const ROOT_DEPARTMENT_ID = 1;
const DINGTALK_DIRECTORY_PAGE_SIZE = 100;
const MAX_DEPARTMENTS = 10_000;
const MAX_PAGES_PER_DEPARTMENT = 10_000;

@Injectable()
export class DingtalkGatewayImpl implements DingtalkGateway {
  private readonly logger = new Logger(DingtalkGatewayImpl.name);

  /** 应用级令牌内存缓存（有效期前 60s 刷新） */
  private appTokenCache: { token: string; expiresAt: number; credentialsFingerprint: string } | null = null;

  /** 网关超时（毫秒） */
  private static readonly TIMEOUT_MS = 5_000;

  /** 请求超时（钉钉不可用时快速失败，映射依赖不可用） */
  private static readonly REQUEST_TIMEOUT = DingtalkGatewayImpl.TIMEOUT_MS;

  constructor(private readonly config: DingtalkConfigService) {}

  /** 钉钉是否已配置（未配置时授权入口返回 DINGTALK_CONFIG_MISSING） */
  async isConfigured(): Promise<boolean> {
    return (await this.config.getOAuthCredentials()) !== null;
  }

  async getConfiguredCorpId(): Promise<string> {
    return (await this.config.getOAuthCredentials())?.corpId ?? '';
  }

  async buildAuthorizeUrl(params: { state: string; redirectUri: string }): Promise<string> {
    const credentials = await this.requireOAuthCredentials();
    const search = new URLSearchParams({
      redirect_uri: params.redirectUri,
      response_type: 'code',
      client_id: credentials.appKey,
      // openid corpid：获取用户 id 及所选组织 id（corpId 必传，scope 含 corpid 时）
      scope: 'openid corpid',
      prompt: 'consent',
      state: params.state,
      corpId: credentials.corpId,
    });
    return `${DINGTALK_LOGIN_BASE}?${search.toString()}`;
  }

  async exchangeCodeForUserToken(code: string): Promise<{ accessToken: string; corpId: string }> {
    const credentials = await this.requireOAuthCredentials();
    const body = await this.request<{ accessToken: string; corpId: string }>(`${DINGTALK_API_BASE}/v1.0/oauth2/userAccessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: credentials.appKey,
        clientSecret: credentials.appSecret,
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
    }>(`${DINGTALK_API_BASE}/v1.0/oauth2/userinfo`, {
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
    }>(`${DINGTALK_API_BASE}/v1.0/contact/users/${encodeURIComponent(unionId)}`, {
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

  /**
   * 按钉钉官方通讯录方案枚举全员：从根部门逐级读取直属子部门，再分别分页读取部门成员。
   * 同一成员可属于多个部门，最终按 unionId 去重；家校通讯录部门 -7 不属于企业内部通讯录。
   */
  async listDirectoryMembers(): Promise<DingtalkDirectoryMember[]> {
    const appToken = await this.getAppAccessToken();
    const departmentIds = await this.listAllDepartmentIds(appToken);
    const members = new Map<string, DingtalkDirectoryMember>();
    for (const departmentId of departmentIds) {
      let cursor = 0;
      const visitedCursors = new Set<number>();
      let hasMore = true;
      for (let pageCount = 0; pageCount < MAX_PAGES_PER_DEPARTMENT; pageCount += 1) {
        if (visitedCursors.has(cursor)) {
          throw new DingtalkUnavailableError('钉钉部门成员分页游标重复');
        }
        visitedCursors.add(cursor);
        const response = await this.requestLegacy<{
          result?: {
            has_more?: boolean | string;
            next_cursor?: number | string;
            list?: Array<{
              unionid?: string;
              name?: string;
              mobile?: string;
              state_code?: string;
              active?: boolean | string;
            }>;
          };
        }>('/topapi/v2/user/list', appToken, {
          dept_id: departmentId,
          cursor,
          size: DINGTALK_DIRECTORY_PAGE_SIZE,
          order_field: 'modify_desc',
          contain_access_limit: false,
          language: 'zh_CN',
        });
        const result = response.result;
        if (!result || !Array.isArray(result.list)) {
          throw new DingtalkUnavailableError('钉钉部门成员接口返回无效');
        }
        for (const member of result.list) {
          const unionId = member.unionid?.trim() ?? '';
          if (!unionId) {
            continue;
          }
          const name = member.name?.trim() ?? '';
          members.set(unionId, {
            unionId,
            name: name || '未命名员工',
            mobile: member.mobile?.trim() ?? '',
            stateCode: member.state_code?.trim() ?? '',
            active: member.active !== false && member.active !== 'false',
          });
        }
        hasMore = result.has_more === true || result.has_more === 'true';
        if (!hasMore) {
          break;
        }
        const nextCursor = Number(result.next_cursor);
        if (!Number.isInteger(nextCursor) || nextCursor < 0) {
          throw new DingtalkUnavailableError('钉钉部门成员分页游标无效');
        }
        cursor = nextCursor;
      }
      if (hasMore) {
        throw new DingtalkUnavailableError('钉钉部门成员分页超过可处理上限');
      }
    }
    return [...members.values()];
  }

  /** 应用级令牌（有内存缓存；过期前 60s 刷新） */
  private async getAppAccessToken(): Promise<string> {
    const credentials = await this.requireOAuthCredentials();
    const credentialsFingerprint = createHash('sha256').update(`${credentials.appKey}:${credentials.appSecret}`).digest('hex');
    if (
      this.appTokenCache &&
      this.appTokenCache.credentialsFingerprint === credentialsFingerprint &&
      Date.now() < this.appTokenCache.expiresAt - 60_000
    ) {
      return this.appTokenCache.token;
    }
    const body = await this.request<{ accessToken?: string; expireIn?: number }>(
      `${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appKey: credentials.appKey, appSecret: credentials.appSecret }),
      },
    );
    if (!body.accessToken) {
      throw new DingtalkUnavailableError('钉钉应用令牌获取失败');
    }
    this.appTokenCache = {
      token: body.accessToken,
      expiresAt: Date.now() + (body.expireIn ?? 7200) * 1000,
      credentialsFingerprint,
    };
    return body.accessToken;
  }

  /** 读取部门树（包含根部门），对外部数据设置有界遍历以防异常树形响应消耗资源。 */
  private async listAllDepartmentIds(appToken: string): Promise<number[]> {
    const result: number[] = [];
    const seen = new Set<number>();
    const queue = [ROOT_DEPARTMENT_ID];
    while (queue.length > 0) {
      const departmentId = queue.shift();
      if (departmentId === undefined || seen.has(departmentId)) {
        continue;
      }
      if (seen.size >= MAX_DEPARTMENTS) {
        throw new DingtalkUnavailableError('钉钉部门数量超过可处理上限');
      }
      seen.add(departmentId);
      result.push(departmentId);
      const response = await this.requestLegacy<{ result?: { dept_id_list?: number[] } }>(
        '/topapi/v2/department/listsubid',
        appToken,
        { dept_id: departmentId },
      );
      const childIds = response.result?.dept_id_list;
      if (!Array.isArray(childIds)) {
        throw new DingtalkUnavailableError('钉钉子部门接口返回无效');
      }
      for (const childId of childIds) {
        if (Number.isInteger(childId) && childId > 0 && childId !== ROOT_DEPARTMENT_ID && childId !== -7 && !seen.has(childId)) {
          queue.push(childId);
        }
      }
    }
    return result;
  }

  /** 旧版通讯录 API 必须把应用令牌放在 query；异常日志绝不输出携带令牌的 URL。 */
  private async requestLegacy<T>(path: string, appToken: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DingtalkGatewayImpl.REQUEST_TIMEOUT);
    try {
      const response = await fetch(`${DINGTALK_LEGACY_API_BASE}${path}?access_token=${encodeURIComponent(appToken)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new DingtalkUnavailableError(`钉钉通讯录接口响应异常（HTTP ${response.status}）`);
      }
      const payload = (await response.json()) as T & { errcode?: number; errmsg?: string };
      if (payload.errcode !== undefined && payload.errcode !== 0) {
        throw new DingtalkUnavailableError('钉钉通讯录接口调用失败');
      }
      return payload;
    } catch (error) {
      if (error instanceof DingtalkUnavailableError) {
        throw error;
      }
      const aborted = error instanceof Error && error.name === 'AbortError';
      this.logger.warn(`钉钉通讯录网关调用失败（${aborted ? '超时' : '连接失败'}）: ${path}`);
      throw new DingtalkUnavailableError(aborted ? '钉钉通讯录网关超时' : '钉钉通讯录网关不可达', error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async requireOAuthCredentials(): Promise<DingtalkOAuthCredentials> {
    const credentials = await this.config.getOAuthCredentials();
    if (!credentials) {
      throw new DingtalkUnavailableError('钉钉应用凭证未配置');
    }
    return credentials;
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
