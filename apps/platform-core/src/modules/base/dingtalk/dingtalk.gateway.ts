/**
 * 钉钉网关抽象（base PRD §2）。
 *
 * 生产实现走钉钉官方 OAuth2 网页扫码流程（凭证仅环境变量，后端兑换）；
 * 单元/集成测试注入 FakeDingtalkGateway（可编程 unionId/手机号/组织不匹配/超时），
 * 不改变生产路径。
 */

/** 钉钉授权返回的用户身份信息 */
export interface DingtalkUserInfo {
  /** 钉钉稳定唯一用户标识（绑定依据，base PRD §2） */
  unionId: string;
  openId: string;
  /** 用户手机号（企业内部应用可拿完整号码） */
  mobile: string;
  /** 手机号国家码（如 86） */
  stateCode: string;
  nick: string;
}

/** 组织成员信息（组织校验 + 手机号兜底） */
export interface DingtalkOrgMember {
  unionId: string;
  mobile: string;
  stateCode: string;
  /** 是否在职成员（active=false 视为非本组织成员） */
  active: boolean;
  departmentIds: number[];
}

/** 钉钉网关（可由部署单元按环境注入实现） */
export interface DingtalkGateway {
  /** 构造 OAuth 授权链接（带一次性 state；redirectUri 与开发者后台配置一致） */
  buildAuthorizeUrl(params: { state: string; redirectUri: string }): string;

  /** 授权码兑换用户访问凭证，返回访问令牌与用户所选组织 ID（组织校验用） */
  exchangeCodeForUserToken(code: string): Promise<{ accessToken: string; corpId: string }>;

  /** 用户信息（unionId/openId/mobile/stateCode） */
  getUserInfo(userToken: string): Promise<DingtalkUserInfo>;

  /** 按 unionId 查询组织成员（校验是否本公司组织在职成员） */
  getOrgMemberByUnionId(unionId: string): Promise<DingtalkOrgMember>;
}

/** 网关注入令牌 */
export const DINGTALK_GATEWAY = Symbol('WBME_DINGTALK_GATEWAY');

/** 网关异常：钉钉不可用/超时（调用方映射 DEPENDENCY_UNAVAILABLE，不得误报组织不匹配） */
export class DingtalkUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DingtalkUnavailableError';
  }
}

/**
 * 网关异常：确认该钉钉账号不属于本公司组织（base PRD §2）。
 * 仅当钉钉明确拒绝（如成员查询返回 403/404 或未返回成员）时抛出；
 * 超时/5xx/网络错误仍走 DingtalkUnavailableError，不得误报为组织不匹配。
 */
export class DingtalkNotMemberError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DingtalkNotMemberError';
  }
}
