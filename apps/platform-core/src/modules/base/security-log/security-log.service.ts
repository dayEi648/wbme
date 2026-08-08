import { Inject, Injectable, Logger } from '@nestjs/common';
import { getRequestContext } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
import type { SecurityEventType as GeneratedSecurityEventType } from '../../../generated/prisma/enums';
import type { Prisma } from '../../../generated/prisma/client';

/**
 * 安全日志服务（主 PRD §9.3、backstage PRD §8）。
 *
 * 认证与账号安全事件（登录/锁定/激活/重置/换绑/手机号同步/内部令牌失败等）逐事件一条
 * 写入 backstage.security_logs（主 PRD §9.4 的共享日志跨 schema 写入例外）；
 * 不落库：密码、凭证、会话标识、邀请原文；手机号只存脱敏形式（maskPhone）。
 * 写入失败退回容器标准错误输出一条脱敏结构化日志，不阻断原认证流程响应。
 * T4-4 迁入 @wbme/logging 统一受限语句时仅替换写入通道，事件枚举与脱敏不重复设计。
 */

/** 事件类型（与 Prisma enum SecurityEventType 对齐；TS 侧直接引用生成类型） */
export type SecurityEventType = GeneratedSecurityEventType;

@Injectable()
export class SecurityLogService {
  private readonly logger = new Logger(SecurityLogService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 写一条安全日志（失败不抛错，退回 stderr）。
   * @param eventType 事件类型（schema 枚举）
   * @param result 成功/失败
   * @param options 主体账号（匿名失败尝试可空）、目标账号、安全化原因、最小上下文（脱敏）
   */
  async record(
    eventType: SecurityEventType,
    result: 'SUCCESS' | 'FAILURE',
    options: {
      actorId?: number | null;
      targetUserId?: number | null;
      reason?: string;
      /** 最小上下文：只允许锁定时长、脱敏手机号等白名单键（调用方自行脱敏） */
      context?: Record<string, unknown>;
      sourceIp?: string | null;
    } = {},
  ): Promise<void> {
    try {
      const requestId = getRequestContext()?.requestId ?? null;
      await this.prisma.client.securityLog.create({
        data: {
          eventType,
          result,
          actorId: options.actorId ?? null,
          targetUserId: options.targetUserId ?? null,
          reason: options.reason ?? null,
          context: options.context ? (options.context as Prisma.InputJsonValue) : undefined,
          sourceIp: options.sourceIp ?? null,
          requestId,
        },
      });
    } catch (error) {
      // 安全日志写入失败不阻断认证流程（主 PRD §9.3：退回容器标准错误输出）
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[security-log] 写入失败（event=${eventType} result=${result} requestId=${getRequestContext()?.requestId ?? '-'}）: ${message}`,
      );
    }
  }
}
