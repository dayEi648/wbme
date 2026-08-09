import type { RawSqlClient } from '@wbme/logging';
import type { Pool } from 'pg';

/**
 * 将 pg Pool 适配为 @wbme/logging RawSqlClient。
 *
 * @param pool PostgreSQL 连接池
 * @returns RawSqlClient
 */
export function createRawSqlClient(pool: Pool): RawSqlClient {
  return {
    async $executeRawUnsafe(query: string, ...values: unknown[]) {
      const result = await pool.query(query, values);
      return result.rowCount ?? 0;
    },
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]) {
      const result = await pool.query(query, values);
      return result.rows as T;
    },
  };
}
