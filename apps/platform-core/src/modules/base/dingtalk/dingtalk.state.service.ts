import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors } from '@wbme/contracts';
import { redisKey, REDIS_NAMESPACE, REDIS_CLIENT } from '@wbme/server';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * 钉钉 OAuth 一次性 state（base PRD §2）。
 *
 * - 授权发起时签发（32B 密码学随机），Redis 存 {purpose, flowId?}，TTL 5 分钟；
 * - 回调校验存在性、purpose 匹配后**取用即删**（一次性，重放拒绝）；
 * - 回调地址与部署配置一致（防开放重定向）；state 不承载任何原始凭证；
 * - 流程类用途（激活/重置）把流程会话标识随 state 携带：钉钉跳转与回调只走
 *   一次性 state/nonce 与流程标识（base PRD §2），不依赖流程 Cookie 覆盖钉钉路径。
 */

/** 钉钉授权用途（回调后按用途分流） */
export const DINGTALK_PURPOSES = ['LOGIN', 'REGISTRATION', 'ACTIVATION', 'RESET'] as const;
export type DingtalkPurpose = (typeof DINGTALK_PURPOSES)[number];

export interface DingtalkStateData {
  purpose: DingtalkPurpose;
  /** 流程类用途（激活/重置）的一次性流程会话标识（回调时据此取流程会话） */
  flowId?: string;
}

const STATE_TTL_SECONDS = 5 * 60;

@Injectable()
export class DingtalkStateService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** 签发一次性 state 并返回；流程类用途需传入已校验的流程会话标识 */
  async issue(purpose: DingtalkPurpose, flowId?: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const data: DingtalkStateData = { purpose, flowId };
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
