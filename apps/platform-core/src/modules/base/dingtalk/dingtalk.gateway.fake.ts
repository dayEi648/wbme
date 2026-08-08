import { DingtalkNotMemberError, type DingtalkGateway, type DingtalkOrgMember, type DingtalkUserInfo } from './dingtalk.gateway';

/**
 * 测试用 FakeDingtalkGateway：可编程 unionId/手机号/组织不匹配/超时。
 * 不改变生产路径（生产走 DingtalkGatewayImpl 真实 HTTP）。
 */
export class FakeDingtalkGateway implements DingtalkGateway {
  /** 可编程行为 */
  behavior: {
    user: DingtalkUserInfo;
    member: DingtalkOrgMember;
    /** 授权码 → token 时抛"组织不匹配"（corpId 与部署配置不一致） */
    orgMismatch?: boolean;
    /** 成员查询明确返回"非本组织成员"（DingtalkNotMemberError） */
    notMember?: boolean;
    /** 模拟钉钉超时/不可用 */
    unavailable?: boolean;
  };

  constructor(
    behavior: Partial<FakeDingtalkGateway['behavior']> = {},
    readonly configured = true,
  ) {
    this.behavior = {
      user: { unionId: 'fake-union-001', openId: 'fake-open-001', mobile: '13800138000', stateCode: '86', nick: '测试用户' },
      member: { unionId: 'fake-union-001', mobile: '13800138000', stateCode: '86', active: true, departmentIds: [1] },
      ...behavior,
    };
  }

  buildAuthorizeUrl(params: { state: string; redirectUri: string }): string {
    const search = new URLSearchParams({ state: params.state, redirect_uri: params.redirectUri });
    return `https://login.dingtalk.io/oauth2/auth?${search.toString()}`;
  }

  async exchangeCodeForUserToken(code: string): Promise<{ accessToken: string; corpId: string }> {
    if (this.behavior.unavailable) {
      throw new Error('fetch failed: ETIMEDOUT');
    }
    if (this.behavior.orgMismatch) {
      return { accessToken: `token-${code}`, corpId: 'wrong-corp' };
    }
    return { accessToken: `token-${code}`, corpId: process.env.DINGTALK_CORP_ID ?? 'test-corp' };
  }

  async getUserInfo(): Promise<DingtalkUserInfo> {
    if (this.behavior.unavailable) {
      throw new Error('fetch failed: ETIMEDOUT');
    }
    return this.behavior.user;
  }

  async getOrgMemberByUnionId(): Promise<DingtalkOrgMember> {
    if (this.behavior.unavailable) {
      throw new Error('fetch failed: ETIMEDOUT');
    }
    if (this.behavior.notMember) {
      throw new DingtalkNotMemberError('钉钉成员查询返回非本组织成员');
    }
    return this.behavior.member;
  }

  isConfigured(): boolean {
    return this.configured;
  }
}
