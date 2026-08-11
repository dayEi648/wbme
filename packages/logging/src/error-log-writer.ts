import { bucketStart, computeErrorFingerprint, upsertErrorLog } from './error-log';
import type { RawSqlClient } from './raw-sql-client';

/** 集中错误日志写入输入（与 GlobalExceptionFilter 的 ErrorLogWriter 回调同形） */
export interface ErrorLogWriterInput {
  errorCategory: 'SYSTEM' | 'DEPENDENCY';
  exception: unknown;
  requestId: string;
  service: string;
  source: string;
  deployCommit: string;
  occurredAt: Date;
}

/**
 * 集中错误日志写入器：供各部署单元 GlobalExceptionFilter fire-and-forget 调用。
 *
 * 无框架依赖：asset/hr/fin 通过各自 Prisma 客户端（$executeRawUnsafe/$queryRawUnsafe）
 * 注入 {@link RawSqlClient}，把未知/依赖异常聚合写入 backstage.error_logs
 * （主 PRD §9.4 跨 schema 写入例外；backstage PRD §8 全服务统一写入）。
 */
export class RawSqlErrorLogWriter {
  constructor(private readonly client: RawSqlClient) {}

  /** 工厂：从 Prisma 客户端（或等价 $queryRawUnsafe/$executeRawUnsafe 实现）构造 */
  static from(client: RawSqlClient): RawSqlErrorLogWriter {
    return new RawSqlErrorLogWriter(client);
  }

  /** fire-and-forget 写入：自捕获异常，不得向上抛出 */
  write(input: ErrorLogWriterInput): void {
    void this.writeAsync(input);
  }

  private async writeAsync(input: ErrorLogWriterInput): Promise<void> {
    try {
      const err = input.exception;
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack ?? '' : '';
      const stackLocation = extractStackLocation(stack);
      const fingerprint = computeErrorFingerprint({
        service: input.service,
        deployCommit: input.deployCommit,
        errorCategory: input.errorCategory,
        entryPoint: input.source,
        stackLocation,
      });
      const ok = await upsertErrorLog(this.client, {
        level: 'ERROR',
        service: input.service,
        source: input.source,
        errorCategory: input.errorCategory,
        deployCommit: input.deployCommit,
        fingerprint,
        bucketStart: bucketStart(input.occurredAt),
        occurredAt: input.occurredAt,
        requestId: input.requestId,
        sample: stack ? `${message}\n${stack}` : message,
      });
      if (!ok) {
        // 写入失败（DB 不可用/超时--最需要日志的时刻）：退回容器标准错误输出（主 PRD §9.3），
        // 与 PlatformErrorLogWriter 行为对齐，不得静默丢失。
        console.error(
          `[error-log] 写入失败（service=${input.service} source=${input.source} category=${input.errorCategory} requestId=${input.requestId}）`,
        );
      }
    } catch (writeError) {
      // fire-and-forget：意外异常不阻塞 HTTP 响应（错误日志本身不得再抛错），仍退回 stderr 兜底
      const reason = writeError instanceof Error ? writeError.message : String(writeError);
      console.error(
        `[error-log] 写入异常（service=${input.service} requestId=${input.requestId}）: ${reason}`,
      );
    }
  }
}

/** 从堆栈提取首个稳定位置（文件:行） */
function extractStackLocation(stack: string): string {
  const match = /at\s+(?:\S+\s+)?\(?([^():]+:\d+:\d+)\)?/.exec(stack);
  return match?.[1] ?? 'unknown';
}
