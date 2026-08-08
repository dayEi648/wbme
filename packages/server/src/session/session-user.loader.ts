import type { UserStatus } from '@wbme/contracts';

/**
 * 会话守卫的用户状态加载器接口。
 *
 * 会话 Redis 只保存用户标识与必要会话状态；账号状态、软删除与版本号
 * 由各部署单元注入的加载器从自身数据库读取（主 PRD §9.6、base PRD §3）：
 * 撤权/注销/改密立即影响后续请求，不等待会话或缓存过期。
 */
export interface SessionUser {
  /** 账号 ID */
  id: number;
  /** 账号状态（PENDING_ACTIVATION 未激活 / ACTIVE 正常 / DEACTIVATED 已注销） */
  status: UserStatus;
  /** 账号会话版本：修改/重置密码、换绑、注销时递增，与会话内版本不一致即失效 */
  sessionVersion: number;
  /** 是否超级管理员（门户入口推导与守卫快捷路径使用） */
  isSuperAdmin: boolean;
}

/** 由部署单元实现并注入（platform-core 读 base.users；其它单元调用只读视图或内部接口） */
export interface SessionUserLoader {
  /** 加载会话用户；账号不存在或已软删除返回 null */
  load(userId: number): Promise<SessionUser | null>;
}
