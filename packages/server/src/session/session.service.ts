import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/tokens';
import { redisKey, REDIS_NAMESPACE } from '../redis/redis-constants';
import { SESSION_ID_BYTES } from './session-constants';

/**
 * 服务端会话数据（Redis 值）。
 *
 * 只保存用户标识与必要会话状态；授权上下文每次请求按当前账号状态与版本重新取得，
 * 不把登录时的授权当作整个会话期内不变的授权事实（base PRD §3）。
 * pv/ov/otv/dv 为授权/组织/目录版本占位（T3-4 权限守卫开始比较，本期写 0）。
 */
export interface SessionData {
  /** 用户 ID */
  u: number;
  /** 会话建立时的账号 session_version */
  sv: number;
  /** 权限版本（T3-4 比较） */
  pv: number;
  /** 用户组织版本（T3-4 比较） */
  ov: number;
  /** 组织树版本（T3-4 比较） */
  otv: number;
  /** 权限目录版本（T3-4 比较） */
  dv: number;
  /** 是否"记住我"会话（仅延长空闲/绝对时限，不取消绝对过期） */
  rm: boolean;
  /** 绝对过期时间点（epoch ms）：独立于空闲续期 */
  abs: number;
}

/** 会话创建参数 */
export interface CreateSessionOptions {
  userId: number;
  /** 当前账号 session_version（改密/重置/换绑/注销后递增，旧会话因版本不一致失效） */
  sessionVersion: number;
  /** 是否"记住我"（延长空闲与绝对时限） */
  rememberMe: boolean;
  /** 空闲超时（毫秒，滑动续期） */
  idleTimeoutMs: number;
  /** 绝对过期（毫秒，自创建起） */
  absoluteTimeoutMs: number;
}

/** 会话续期结果 */
export interface TouchResult {
  /** 会话是否仍有效（绝对过期已到则无效） */
  valid: boolean;
  /** 新的过期时间点（epoch ms） */
  expiresAt: number;
}

/**
 * 服务端会话服务（主 PRD §9.8、base PRD §3）。
 *
 * - 单 TTL 表达双机制：TTL = min(绝对剩余, 空闲超时)；有效交互 EXPIRE 重算滑动续期，
 *   绝对过期独立生效且不可被续期取消；
 * - sessionId 为 128bit 密码学随机值，登录成功/提权必须轮换（防会话固定）；
 * - "修改密码后全部会话失效"由 DB 侧 session_version 递增保证：旧会话下次请求
 *   版本不一致即被守卫拒绝并删除，无需 Redis 遍历（base PRD §3）；
 * - 会话数据不是授权事实来源，Redis 丢失只导致全员重新登录（主 PRD §9.8）。
 */
@Injectable()
export class SessionService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** 创建会话，返回 sessionId 与绝对过期时间点 */
  async create(options: CreateSessionOptions): Promise<{ sessionId: string; expiresAt: number }> {
    const sessionId = randomBytes(SESSION_ID_BYTES).toString('base64url');
    const now = Date.now();
    const data: SessionData = {
      u: options.userId,
      sv: options.sessionVersion,
      pv: 0,
      ov: 0,
      otv: 0,
      dv: 0,
      rm: options.rememberMe,
      abs: now + options.absoluteTimeoutMs,
    };
    const ttlMs = Math.min(options.idleTimeoutMs, options.absoluteTimeoutMs);
    await this.redis.set(redisKey(REDIS_NAMESPACE.SESSION, sessionId), JSON.stringify(data), 'PX', ttlMs);
    return { sessionId, expiresAt: data.abs };
  }

  /**
   * 读取会话并校验绝对过期（不续期）。
   * @returns 有效会话数据；不存在或已绝对过期返回 null（调用方应删除失效键）
   */
  async read(sessionId: string): Promise<SessionData | null> {
    const raw = await this.redis.get(redisKey(REDIS_NAMESPACE.SESSION, sessionId));
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw) as SessionData;
    if (data.abs <= Date.now()) {
      await this.redis.del(redisKey(REDIS_NAMESPACE.SESSION, sessionId));
      return null;
    }
    return data;
  }

  /**
   * 空闲滑动续期：重算 TTL = min(绝对剩余, 空闲超时)。
   * 只由已认证用户在前台触发的有效交互产生（守卫按 X-WBME-Active 头判定）。
   */
  async touch(sessionId: string, data: SessionData, idleTimeoutMs: number): Promise<TouchResult> {
    const remainingAbs = data.abs - Date.now();
    if (remainingAbs <= 0) {
      await this.redis.del(redisKey(REDIS_NAMESPACE.SESSION, sessionId));
      return { valid: false, expiresAt: 0 };
    }
    const ttlMs = Math.min(idleTimeoutMs, remainingAbs);
    await this.redis.pexpire(redisKey(REDIS_NAMESPACE.SESSION, sessionId), ttlMs);
    return { valid: true, expiresAt: Date.now() + ttlMs };
  }

  /** 删除单个会话（登出） */
  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(redisKey(REDIS_NAMESPACE.SESSION, sessionId));
  }

  /**
   * 轮换会话标识（防会话固定，base PRD §3）：登录成功与提权场景调用。
   * 删除旧会话并创建新会话，返回新 sessionId。
   */
  async rotate(
    oldSessionId: string,
    options: CreateSessionOptions,
  ): Promise<{ sessionId: string; expiresAt: number }> {
    await this.destroy(oldSessionId);
    return this.create(options);
  }
}
