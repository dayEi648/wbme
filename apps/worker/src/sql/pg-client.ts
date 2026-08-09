import type { Pool } from 'pg';
import type { SqlClient } from '@wbme/tasks';

/**
 * 将 pg Pool 适配为 @wbme/tasks SqlClient。
 *
 * @param pool PostgreSQL 连接池
 * @returns SqlClient
 */
export function createSqlClient(pool: Pool): SqlClient {
  return {
    async query(text: string, values?: readonly unknown[]) {
      const result = await pool.query(text, values as unknown[] | undefined);
      return { rowCount: result.rowCount };
    },
    async queryRows<T>(text: string, values?: readonly unknown[]) {
      const result = await pool.query(text, values as unknown[] | undefined);
      return result.rows as T[];
    },
  };
}
