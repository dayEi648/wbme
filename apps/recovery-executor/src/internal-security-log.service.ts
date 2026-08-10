import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { insertSecurityLog, type RawSqlClient } from '@wbme/logging';
import { Pool } from 'pg';

/** 内部令牌拒绝的脱敏审计字段 */
export interface InternalTokenFailure {
  reason: 'TOKEN_UNCONFIGURED' | 'TOKEN_INVALID' | 'CALLER_NOT_ALLOWED';
  caller: string | null;
  sourceIp: string | null;
  requestId: string | null;
}

/** 内部令牌拒绝记录器接口（便于守卫测试替换） */
export interface InternalTokenFailureRecorder {
  recordInternalTokenFailure(failure: InternalTokenFailure): Promise<void>;
}

/**
 * 恢复执行器的集中安全日志写入器（backstage PRD §8）。
 *
 * 恢复执行器没有 Prisma 模块，故以一个上限为 1 的 pg 连接池适配共享日志模块；日志
 * 写入超时或数据库不可用不影响 401/403 决策，但会明确退回 stderr，且不记录令牌原文。
 */
@Injectable()
export class InternalSecurityLogService implements InternalTokenFailureRecorder, OnModuleDestroy {
  private readonly logger = new Logger(InternalSecurityLogService.name);
  private pool: Pool | null = null;

  /**
   * 写入 INTERNAL_TOKEN_FAILED 事件。
   *
   * @param failure 已脱敏的拒绝上下文
   * @returns 无；失败仅输出最小 stderr 兜底
   */
  async recordInternalTokenFailure(failure: InternalTokenFailure): Promise<void> {
    try {
      const pool = this.getPool();
      if (!pool) {
        this.logFallback(failure.reason, failure.requestId);
        return;
      }
      const client: RawSqlClient = {
        $executeRawUnsafe: async (query, ...values) => {
          const result = await pool.query(query, values);
          return result.rowCount ?? 0;
        },
        $queryRawUnsafe: async <T>(query: string, ...values: unknown[]) => {
          const result = await pool.query(query, values);
          return result.rows as T;
        },
      };
      const written = await insertSecurityLog(client, {
        eventType: 'INTERNAL_TOKEN_FAILED',
        result: 'FAILURE',
        reason: failure.reason,
        sourceIp: failure.sourceIp,
        context: failure.caller ? { caller: failure.caller } : null,
        requestId: failure.requestId,
      });
      if (!written) {
        this.logFallback(failure.reason, failure.requestId);
      }
    } catch {
      this.logFallback(failure.reason, failure.requestId);
    }
  }

  /** 关闭日志连接池，避免恢复执行器优雅停机时保留连接 */
  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /** 延迟创建单连接池；未配置数据库时不尝试本机默认连接 */
  private getPool(): Pool | null {
    if (this.pool) {
      return this.pool;
    }
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
      return null;
    }
    this.pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 10_000,
    });
    return this.pool;
  }

  /** 集中日志不可用时输出不含凭证的最小诊断 */
  private logFallback(reason: InternalTokenFailure['reason'], requestId: string | null): void {
    this.logger.error(`[security-log] INTERNAL_TOKEN_FAILED 写入失败 reason=${reason} requestId=${requestId ?? '-'}`);
  }
}
