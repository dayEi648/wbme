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
} as const satisfies Readonly<Record<string, ErrorEntry>>;
