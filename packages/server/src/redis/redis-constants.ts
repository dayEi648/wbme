/**
 * Redis 命名空间约定（主 PRD §9.8）。
 *
 * 单 Redis 实例被 platform-core、asset、hr、fin 与 Worker 共享，
 * 各用途使用固定命名空间，避免会话、限流、队列、配置广播与分布式锁键相互覆盖。
 */

export const REDIS_NAMESPACE = {
  /** 服务端会话 */
  SESSION: 'session',
  /** 登录与接口限流计数 */
  RATE_LIMIT: 'ratelimit',
  /** BullMQ 队列（Worker 唤醒） */
  QUEUE: 'queue',
  /** 系统设置变更广播 */
  CONFIG: 'config',
  /** 分布式锁 */
  LOCK: 'lock',
  /** 幂等响应近期缓存 */
  IDEMPOTENCY: 'idem',
  /** 未关联业务图片临时对象待清理记录 */
  UPLOAD_PENDING: 'upload',
  /** 钉钉 OAuth 一次性 state（base PRD §2：回调校验、取用即删） */
  DINGTALK_STATE: 'dtstate',
  /** 激活/注册/重置的一次性流程会话（Path 限定 Cookie 对应） */
  FLOW_TOKEN: 'flowtoken',
} as const;

export type RedisNamespace = (typeof REDIS_NAMESPACE)[keyof typeof REDIS_NAMESPACE];

/**
 * 生成命名空间隔离的 Redis 键。
 * @param namespace 用途命名空间
 * @param parts 业务键片段（如 userId、业务标识）
 * @returns `{namespace}:{part1}:{part2}...`
 */
export function redisKey(namespace: RedisNamespace, ...parts: Array<string | number>): string {
  return [namespace, ...parts].join(':');
}
