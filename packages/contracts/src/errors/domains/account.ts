import type { ErrorEntry } from '../types';

/** ACCOUNT 域错误目录：注册登录、激活邀请、钉钉绑定、账号生命周期（base PRD） */
export const accountErrors = {
  /** 登录失败统一提示：不泄露账号是否存在（base PRD §2） */
  INVALID_CREDENTIALS: {
    code: 'INVALID_CREDENTIALS',
    type: 'AUTHENTICATION',
    domain: 'ACCOUNT',
    httpStatus: 401,
    message: '手机号或密码错误',
  },
  /** 登录保护锁定（base PRD §4） */
  ACCOUNT_LOCKED: {
    code: 'ACCOUNT_LOCKED',
    type: 'AUTHENTICATION',
    domain: 'ACCOUNT',
    httpStatus: 401,
    message: '尝试过多，请稍后再试',
  },
  /** 账号已注销：扫码或手机号登录命中已注销账号（base PRD §2） */
  ACCOUNT_DEACTIVATED: {
    code: 'ACCOUNT_DEACTIVATED',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '账号已注销，请联系管理员恢复',
  },
  /** 账号尚未激活，无法登录 */
  ACCOUNT_PENDING_ACTIVATION: {
    code: 'ACCOUNT_PENDING_ACTIVATION',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '账号尚未激活',
  },
  /** 激活邀请无效/过期/已使用，统一提示（base PRD §2） */
  INVITATION_INVALID: {
    code: 'INVITATION_INVALID',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '激活邀请无效或已过期，请联系管理员重新生成',
  },
  /** 手机号已被其他"待激活/正常"账号占用（base PRD §2） */
  PHONE_TAKEN: {
    code: 'PHONE_TAKEN',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '该手机号已被使用，请联系管理员处理',
  },
  /** 扫码注册命中待激活基础账号（base PRD §2） */
  PENDING_ACCOUNT_EXISTS: {
    code: 'PENDING_ACCOUNT_EXISTS',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '已有待激活账号，请联系管理员获取激活邀请',
  },
  /** 钉钉授权组织与部署配置的公司组织不一致（base PRD §2） */
  DINGTALK_ORG_MISMATCH: {
    code: 'DINGTALK_ORG_MISMATCH',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '当前钉钉账号不属于本公司组织',
  },
  /** 一个钉钉账号只能绑定一个平台账号（base PRD §2） */
  DINGTALK_ALREADY_BOUND: {
    code: 'DINGTALK_ALREADY_BOUND',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '该钉钉账号已绑定其他平台账号，请走账号恢复或换绑流程',
  },
  /** 一个平台账号只能绑定一个钉钉账号（base PRD §2） */
  BINDING_ALREADY_EXISTS: {
    code: 'BINDING_ALREADY_EXISTS',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '该账号已绑定钉钉身份，请走换绑流程',
  },
  /** 钉钉授权 state 缺失/过期/已使用（base PRD §2：一次性 state/nonce 校验） */
  DINGTALK_STATE_INVALID: {
    code: 'DINGTALK_STATE_INVALID',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '授权请求已过期，请重新扫码登录',
  },
  /** 钉钉授权过程失败（授权码无效/换 token 失败等） */
  DINGTALK_AUTHORIZATION_FAILED: {
    code: 'DINGTALK_AUTHORIZATION_FAILED',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '钉钉授权失败，请重试',
  },
  /** 钉钉应用未配置（部署环境缺凭证，base PRD §2） */
  DINGTALK_CONFIG_MISSING: {
    code: 'DINGTALK_CONFIG_MISSING',
    type: 'DEPENDENCY',
    domain: 'ACCOUNT',
    httpStatus: 503,
    message: '钉钉登录暂未配置，请使用手机号登录',
  },
  /** 钉钉授权结果未返回手机号（base PRD §2：无手机号不能注册/激活） */
  PHONE_MISSING_FROM_DINGTALK: {
    code: 'PHONE_MISSING_FROM_DINGTALK',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '钉钉未返回手机号，请联系管理员检查钉钉通讯录资料',
  },
  /** 流程会话（激活/注册/重置/换绑的短时一次性会话）无效/过期/已使用 */
  FLOW_SESSION_INVALID: {
    code: 'FLOW_SESSION_INVALID',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '操作已过期，请重新开始',
  },
  /** 目标账号不处于待激活状态（仅待激活可生成激活邀请） */
  USER_NOT_PENDING: {
    code: 'USER_NOT_PENDING',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '该账号不处于待激活状态',
  },
  /** 目标账号不处于正常状态（仅 ACTIVE 可重置/换绑） */
  USER_NOT_ACTIVE: {
    code: 'USER_NOT_ACTIVE',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '仅正常状态账号可执行该操作',
  },
  /** 兑换邀请时发现账号已激活（base PRD §2：已激活拒绝激活） */
  ACCOUNT_ACTIVATED: {
    code: 'ACCOUNT_ACTIVATED',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '该账号已激活，请直接登录',
  },
  /** 修改密码时旧密码错误（不泄露账号信息，复用统一提示语义） */
  OLD_PASSWORD_INCORRECT: {
    code: 'OLD_PASSWORD_INCORRECT',
    type: 'AUTHENTICATION',
    domain: 'ACCOUNT',
    httpStatus: 401,
    message: '当前密码不正确',
  },
  /** 换绑时账号当前没有有效钉钉绑定（无法完成替换） */
  BINDING_NOT_FOUND: {
    code: 'BINDING_NOT_FOUND',
    type: 'CONFLICT',
    domain: 'ACCOUNT',
    httpStatus: 409,
    message: '该账号暂无钉钉绑定，无需换绑',
  },
  /** 同一员工已存在待审批资料修改申请（主 PRD §3.2 单待审批限制） */
  PROFILE_CHANGE_PENDING_EXISTS: {
    code: 'PROFILE_CHANGE_PENDING_EXISTS',
    type: 'CONFLICT',
    domain: 'ACCOUNT',
    httpStatus: 409,
    message: '已有待审批的资料修改申请，请等待处理完成',
  },
  /** 自助重置不可用：账号不存在或未绑定钉钉（统一提示防手机号枚举，base PRD §2） */
  RESET_SELF_UNAVAILABLE: {
    code: 'RESET_SELF_UNAVAILABLE',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '无法自助重置密码，请绑定钉钉后重试或联系管理员',
  },
  /** 岗位变更申请不满足资格（多部门员工/岗位未启用/不允许自助申请/不适用目标部门；T6-6 启用） */
  POSITION_APPLICATION_INELIGIBLE: {
    code: 'POSITION_APPLICATION_INELIGIBLE',
    type: 'BUSINESS',
    domain: 'ACCOUNT',
    httpStatus: 422,
    message: '当前不满足岗位变更申请条件',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
