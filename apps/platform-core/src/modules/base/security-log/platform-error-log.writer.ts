import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  bucketStart,
  computeErrorFingerprint,
  upsertErrorLog,
  type RawSqlClient,
} from '@wbme/logging';
import type { ErrorLogWriter } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';

/**
 * 集中错误日志写入器（T4-3）：供 GlobalExceptionFilter fire-and-forget 调用。
 */
@Injectable()
export class PlatformErrorLogWriter implements ErrorLogWriter {
  private readonly logger = new Logger(PlatformErrorLogWriter.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  write(input: {
    errorCategory: 'SYSTEM' | 'DEPENDENCY';
    exception: unknown;
    requestId: string;
    service: string;
    source: string;
    deployCommit: string;
    occurredAt: Date;
  }): void {
    void this.writeAsync(input);
  }

  private async writeAsync(input: {
    errorCategory: 'SYSTEM' | 'DEPENDENCY';
    exception: unknown;
    requestId: string;
    service: string;
    source: string;
    deployCommit: string;
    occurredAt: Date;
  }): Promise<void> {
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
    const client = this.prisma.client as unknown as RawSqlClient;
    const ok = await upsertErrorLog(client, {
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
      this.logger.error(
        `[error-log] 写入失败（category=${input.errorCategory} requestId=${input.requestId}）`,
      );
    }
  }
}

/** 从堆栈提取首个稳定位置（文件:行） */
function extractStackLocation(stack: string): string {
  const match = /at\s+(?:\S+\s+)?\(?([^():]+:\d+:\d+)\)?/.exec(stack);
  return match?.[1] ?? 'unknown';
}
