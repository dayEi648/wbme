import type { ErrorEntry } from '../types';

/** PERMISSION 域错误目录：功能授权、权限组、超级管理员保护（主 PRD §3.1） */
export const permissionErrors = {
  /** 授权版本冲突：保存时携带的版本已过期（backstage PRD §4） */
  GRANT_VERSION_CONFLICT: {
    code: 'GRANT_VERSION_CONFLICT',
    type: 'CONFLICT',
    domain: 'PERMISSION',
    httpStatus: 409,
    message: '权限已被他人更新，请刷新后重试',
  },
  /** 操作人不能修改自己的授权（防止自我提权，主 PRD §3.1） */
  GRANT_SELF_FORBIDDEN: {
    code: 'GRANT_SELF_FORBIDDEN',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '不能修改自己的权限',
  },
  /** 最后一名超级管理员不可卸任/降级（主 PRD §3.1） */
  LAST_SUPER_ADMIN: {
    code: 'LAST_SUPER_ADMIN',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '系统必须保留至少一名超级管理员',
  },
  /** 任命目标已是超级管理员（重复任命） */
  ALREADY_SUPER_ADMIN: {
    code: 'ALREADY_SUPER_ADMIN',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '目标已是超级管理员',
  },
  /** 降级目标不是超级管理员 */
  NOT_SUPER_ADMIN: {
    code: 'NOT_SUPER_ADMIN',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '目标不是超级管理员',
  },
  /** 系统开放状态不可调整（backstage 恒开放；BASE 不进入目录）（backstage PRD §6） */
  SYSTEM_STATUS_NOT_ADJUSTABLE: {
    code: 'SYSTEM_STATUS_NOT_ADJUSTABLE',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '该系统的开放状态不可调整',
  },
  /** 超级管理员账号仅可由超级管理员管理（backstage PRD §3） */
  SUPER_ADMIN_TARGET_ONLY: {
    code: 'SUPER_ADMIN_TARGET_ONLY',
    type: 'AUTHORIZATION',
    domain: 'PERMISSION',
    httpStatus: 403,
    message: '超级管理员账号仅可由超级管理员管理',
  },
  /** "权限管理"功能仅超级管理员可授予或撤销（主 PRD §3.1） */
  PERMISSION_MANAGEMENT_GRANT_FORBIDDEN: {
    code: 'PERMISSION_MANAGEMENT_GRANT_FORBIDDEN',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '"权限管理"功能仅超级管理员可授予或撤销',
  },
  /** 功能不支持所选数据范围档位（主 PRD §3.1） */
  SCOPE_NOT_SUPPORTED: {
    code: 'SCOPE_NOT_SUPPORTED',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '该功能不支持所选数据范围',
  },
  /** 授权目标功能未注册或已从目录移除（生效判断以目录中存在为准，主 PRD §3.1） */
  FUNCTION_NOT_REGISTERED: {
    code: 'FUNCTION_NOT_REGISTERED',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '功能未注册或已从目录移除',
  },
  /** 批量授权/撤销：任一目标校验失败则整批回滚并逐人返回阻塞原因（backstage PRD §4） */
  GRANT_BATCH_BLOCKED: {
    code: 'GRANT_BATCH_BLOCKED',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '部分目标无法完成权限变更，整批未生效',
    detailsFields: ['failures'],
  },
  /** 权限组名称已被使用（S-6 名称唯一约束覆盖已软删除组） */
  GROUP_NAME_CONFLICT: {
    code: 'GROUP_NAME_CONFLICT',
    type: 'CONFLICT',
    domain: 'PERMISSION',
    httpStatus: 409,
    message: '权限组名称已被使用',
  },
  /** 批量删除权限组：任一目标不存在/已删除则整批回滚并逐项返回原因（主 PRD §2.6） */
  GROUP_BATCH_BLOCKED: {
    code: 'GROUP_BATCH_BLOCKED',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '部分权限组无法删除，整批未生效',
    detailsFields: ['failures'],
  },
  /** 菜单配置结构不合法：重复标识、悬空分组引用、超出资源上限等（主 PRD §2.1 菜单管理） */
  MENU_CONFIG_STRUCTURE_INVALID: {
    code: 'MENU_CONFIG_STRUCTURE_INVALID',
    type: 'BUSINESS',
    domain: 'PERMISSION',
    httpStatus: 422,
    message: '菜单配置结构不合法',
    detailsFields: ['reason'],
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
