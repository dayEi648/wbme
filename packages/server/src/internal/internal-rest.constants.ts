/**
 * 内部 REST 契约常量（主 PRD §9.4）。
 *
 * 内部 REST 只用于不同部署单元之间的调用，统一使用 `/internal/v1` 前缀，
 * 只在 Docker Compose 私有网络（生产）或本地回环（开发）中可达，Nginx 不得暴露到公网。
 */

/** 内部路由前缀 */
export const INTERNAL_PREFIX = 'internal/v1';

/** 调用方服务枚举（固定枚举，用于白名单授权） */
export const INTERNAL_SERVICES = [
  'platform-core',
  'asset',
  'hr',
  'fin',
  'worker',
  'recovery-executor',
  // 生产发布脚本（宿主经 docker compose exec 在容器内调用；backstage PRD §9 更新日志追加）
  'release-script',
  // 迁移执行器（部署迁移前触发立即备份；主 PRD §9.9）
  'migration-runner',
] as const;

export type InternalService = (typeof INTERNAL_SERVICES)[number];

/** 共享内部令牌：`Authorization: Bearer <token>` */
export const INTERNAL_TOKEN_HEADER = 'authorization';

/** 调用方服务名：`X-WBME-Caller: <service>` */
export const INTERNAL_CALLER_HEADER = 'x-wbme-caller';

/** 追踪标识传播：`X-Request-Id`（与请求上下文同 header） */
export const INTERNAL_TRACE_HEADER = 'x-request-id';

/** 共享内部令牌最短长度（高熵约束，主 PRD §9.4） */
export const INTERNAL_TOKEN_MIN_LENGTH = 32;
