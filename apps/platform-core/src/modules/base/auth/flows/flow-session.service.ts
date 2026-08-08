import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors } from '@wbme/contracts';
import { redisKey, REDIS_NAMESPACE, REDIS_CLIENT } from '@wbme/server';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * 一次性流程会话（base PRD §2：激活/注册/重置/换绑的"短时一次性会话"）。
 *
 * - 兑换或发起成功后签发：Redis `flowtoken:{id}` = {purpose, userId?, unionId?, verifiedFlags, expiresAt}；
 * - 值 = 128bit 密码学随机，通过 Path 限定的一次性流程 Cookie 承接后续步骤；
 * - TTL 30 分钟，一次性：确认成功后或失败即删，重放拒绝；
 * - 钉钉跳转/回调只携带 state + purpose，绝不携带原始凭证。
 */

/** 流程用途（与钉钉 state purpose 对应） */
export const FLOW_PURPOSES = ['REGISTRATION', 'ACTIVATION', 'RESET', 'REBIND'] as const;
export type FlowPurpose = (typeof FLOW_PURPOSES)[number];

export interface FlowSessionData {
  purpose: FlowPurpose;
  /** 目标账号（重置/换绑场景已确定；注册场景为 null） */
  userId?: number;
  /** 已完成的钉钉授权身份（激活/注册/换绑场景） */
  unionId?: string;
  /** 钉钉返回的手机号与国家码（回调时写入，确认时使用） */
  mobile?: string;
  stateCode?: string;
  /** 换绑场景：旧身份已验证标记 */
  verifiedFlags?: string[];
  expiresAt: number;
}

const FLOW_TTL_SECONDS = 30 * 60;

@Injectable()
export class FlowSessionService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** 签发流程会话，返回 flowSessionId */
  async issue(purpose: FlowPurpose, data: Omit<FlowSessionData, 'purpose' | 'expiresAt'>): Promise<string> {
    const flowId = randomBytes(16).toString('base64url');
    const payload: FlowSessionData = {
      purpose,
      ...data,
      expiresAt: Date.now() + FLOW_TTL_SECONDS * 1000,
    };
    await this.redis.set(
      redisKey(REDIS_NAMESPACE.FLOW_TOKEN, flowId),
      JSON.stringify(payload),
      'EX',
      FLOW_TTL_SECONDS,
    );
    return flowId;
  }

  /**
   * 读取并校验流程会话（不消费）。
   * @returns 会话数据；无效/过期返回 null（调用方统一提示重新开始）
   */
  async read(flowId: string, expectedPurpose?: FlowPurpose): Promise<FlowSessionData | null> {
    const raw = await this.redis.get(redisKey(REDIS_NAMESPACE.FLOW_TOKEN, flowId));
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw) as FlowSessionData;
    if (data.expiresAt <= Date.now()) {
      await this.redis.del(redisKey(REDIS_NAMESPACE.FLOW_TOKEN, flowId));
      return null;
    }
    if (expectedPurpose && data.purpose !== expectedPurpose) {
      return null;
    }
    return data;
  }

  /** 消费流程会话（确认成功后或失败即删，一次性语义） */
  async consume(flowId: string): Promise<void> {
    await this.redis.del(redisKey(REDIS_NAMESPACE.FLOW_TOKEN, flowId));
  }

  /** 更新流程会话数据（如回调后写入 unionId），保持原 TTL */
  async update(flowId: string, data: FlowSessionData): Promise<void> {
    await this.redis.set(redisKey(REDIS_NAMESPACE.FLOW_TOKEN, flowId), JSON.stringify(data), 'KEEPTTL');
  }

  /** 断言流程会话有效并返回（无效抛统一错误） */
  async assert(flowId: string, expectedPurpose: FlowPurpose): Promise<FlowSessionData> {
    const data = await this.read(flowId, expectedPurpose);
    if (!data) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    return data;
  }
}
