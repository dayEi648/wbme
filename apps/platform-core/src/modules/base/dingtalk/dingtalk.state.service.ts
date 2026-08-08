import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors } from '@wbme/contracts';
import { redisKey, REDIS_NAMESPACE, REDIS_CLIENT } from '@wbme/server';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * 钉钉 OAuth 一次性 state（base PRD §2）。
 *
 * - 授权发起时签发（32B 密码学随机），Redis 存 {purpose, returnTo}，TTL 5 分钟；
 * - 回调校验存在性、purpose 匹配后**取用即删**（一次性，重放拒绝）；
 * - 回调地址与部署配置一致（防开放重定向）；state 不承载任何原始凭证。
 */

/** 钉钉授权用途（回调后按用途分流） */
export const DINGTALK_PURPOSES = ['LOGIN', 'REGISTRATION', 'ACTIVATION', 'RESET', 'REBIND'] as const;
export type DingtalkPurpose = (typeof DINGTALK_PURPOSES)[number];

export interface DingtalkStateData {
  purpose: DingtalkPurpose;
  /** 授权成功后的前端回跳地址（仅同源相对路径） */
  returnTo?: string;
}

const STATE_TTL_SECONDS = 5 * 60;

@Injectable()
export class DingtalkStateService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** 签发一次性 state 并返回 */
  async issue(purpose: DingtalkPurpose, returnTo?: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const data: DingtalkStateData = { purpose, returnTo };
    await this.redis.set(redisKey(REDIS_NAMESPACE.DINGTALK_STATE, state), JSON.stringify(data), 'EX', STATE_TTL_SECONDS);
    return state;
  }

  /**
   * 校验并消费 state（一次性）。
   * @returns state 载荷；不存在/已使用抛 DINGTALK_STATE_INVALID
   */
  async consume(state: string, expectedPurpose?: DingtalkPurpose): Promise<DingtalkStateData> {
    const key = redisKey(REDIS_NAMESPACE.DINGTALK_STATE, state);
    const raw = await this.redis.get(key);
    if (!raw) {
      throw new BusinessException(accountErrors.DINGTALK_STATE_INVALID);
    }
    // 取用即删（一次性）
    await this.redis.del(key);
    const data = JSON.parse(raw) as DingtalkStateData;
    if (expectedPurpose && data.purpose !== expectedPurpose) {
      throw new BusinessException(accountErrors.DINGTALK_STATE_INVALID);
    }
    return data;
  }
}
