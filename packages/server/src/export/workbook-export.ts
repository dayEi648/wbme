import { BusinessException, exportErrors } from '@wbme/contracts';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import type { Redis } from 'ioredis';
import { REDIS_NAMESPACE, redisKey } from '../redis/redis-constants';
import { sanitizeExportCell } from './export-cell-sanitize';

export { sanitizeExportCell } from './export-cell-sanitize';

/** 导出总时限（毫秒）：120 秒 */
export const EXPORT_TIMEOUT_MS = 120_000;

/** 互斥锁释放 Lua：仅当锁值仍为本请求令牌时才删除（防旧请求误删新请求锁） */
const RELEASE_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/** 导出列定义 */
export interface ExportColumn<T> {
  /** 表头标题 */
  header: string;
  /** 从行数据取值 */
  value: (row: T) => string | number | boolean | null | undefined;
}

/** runExport 入参 */
export interface RunExportOptions<T> {
  userId: number;
  redis: Redis;
  maxRows: number;
  filename: string;
  columns: ExportColumn<T>[];
  /** 在 REPEATABLE READ 事务内统计行数 */
  fetchCount: (tx: unknown) => Promise<number>;
  /** 在同事务内分页拉取行（offset 从 0 起） */
  fetchRows: (tx: unknown, offset: number, limit: number) => Promise<T[]>;
  /** Prisma $transaction 函数 */
  transaction: <R>(fn: (tx: unknown) => Promise<R>, options?: { isolationLevel?: string; timeout?: number }) => Promise<R>;
  res: Response;
}

/**
 * 通用 Excel 导出：Redis 互斥 + REPEATABLE READ 快照 + 流式写响应。
 *
 * @param options 导出参数
 * @throws BusinessException EXPORT_ALREADY_RUNNING / ROW_LIMIT_EXCEEDED / EXPORT_TIMEOUT
 */
export async function runExport<T>(options: RunExportOptions<T>): Promise<void> {
  const lockKey = redisKey(REDIS_NAMESPACE.LOCK, 'export', options.userId);
  // 锁值 = 本请求随机令牌：超时/异常的旧请求在 finally 释放时只删自己的锁（主 PRD §10.3 安全释放）
  const lockToken = randomUUID();
  // 锁 TTL 比超时上限多 30s：避免极端时序下任务仍在执行但锁已提前过期（并发 429 语义失效）
  const lockTtlSeconds = Math.ceil(EXPORT_TIMEOUT_MS / 1000) + 30;
  const acquired = await options.redis.set(lockKey, lockToken, 'EX', lockTtlSeconds, 'NX');
  if (acquired !== 'OK') {
    throw new BusinessException(exportErrors.EXPORT_ALREADY_RUNNING);
  }

  const started = Date.now();
  const checkTimeout = (): void => {
    if (Date.now() - started > EXPORT_TIMEOUT_MS) {
      throw new BusinessException(exportErrors.EXPORT_TIMEOUT);
    }
  };

  try {
    await options.transaction(
      async (tx) => {
        const total = await options.fetchCount(tx);
        checkTimeout();
        if (total > options.maxRows) {
          throw new BusinessException(exportErrors.ROW_LIMIT_EXCEEDED, {
            actualRows: total,
            limit: options.maxRows,
          });
        }

        options.res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        options.res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(options.filename)}"`);

        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: options.res, useStyles: false });
        const sheet = workbook.addWorksheet('Export');
        sheet.addRow(options.columns.map((col) => col.header)).commit();

        const batchSize = 500;
        for (let offset = 0; offset < total; offset += batchSize) {
          checkTimeout();
          const rows = await options.fetchRows(tx, offset, batchSize);
          for (const row of rows) {
            sheet
              .addRow(options.columns.map((col) => sanitizeExportCell(col.value(row))))
              .commit();
          }
        }
        await workbook.commit();
      },
      { isolationLevel: 'RepeatableRead', timeout: EXPORT_TIMEOUT_MS },
    );
  } finally {
    // 仅当锁仍是本请求持有时才释放（原子比较删除）
    await options.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, lockToken);
  }
}
