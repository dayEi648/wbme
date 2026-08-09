import { Inject, Injectable, Logger } from '@nestjs/common';
import { getRequestContext } from '@wbme/server';
import { insertSecurityLog, type RawSqlClient } from '@wbme/logging';
import { PrismaService } from '../../../prisma.service';
import type { SecurityEventType as GeneratedSecurityEventType } from '../../../generated/prisma/enums';

/**
 * 安全日志服务（主 PRD §9.3、backstage PRD §8）。
 *
 * 认证与账号安全事件逐条写入 backstage.security_logs；
 * 写入通道由 @wbme/logging insertSecurityLog 统一受限语句实现。
 */

/** 事件类型（与 Prisma enum SecurityEventType 对齐） */
export type SecurityEventType = GeneratedSecurityEventType;

@Injectable()
export class SecurityLogService {
  private readonly logger = new Logger(SecurityLogService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 写一条安全日志（失败不抛错，退回 stderr）。
   *
   * @param eventType 事件类型（schema 枚举）
   * @param result 成功/失败
   * @param options 主体账号、目标账号、安全化原因、最小上下文（脱敏）
   */
  async record(
    eventType: SecurityEventType,
    result: 'SUCCESS' | 'FAILURE',
    options: {
      actorId?: number | null;
      targetUserId?: number | null;
      reason?: string;
      context?: Record<string, unknown>;
      sourceIp?: string | null;
    } = {},
  ): Promise<void> {
    const requestId = getRequestContext()?.requestId ?? null;
    const client = this.prisma.client as unknown as RawSqlClient;
    const ok = await insertSecurityLog(client, {
      eventType,
      result,
      actorId: options.actorId ?? null,
      targetUserId: options.targetUserId ?? null,
      reason: options.reason ?? null,
      context: options.context ?? null,
      sourceIp: options.sourceIp ?? null,
      requestId,
    });
    if (!ok) {
      this.logger.error(
        `[security-log] 写入失败（event=${eventType} result=${result} requestId=${requestId ?? '-'}）`,
      );
    }
  }
}
