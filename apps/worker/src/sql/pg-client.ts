import type { Pool, PoolClient } from 'pg';
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
    // 事务化超时取消（状态迁移与占用释放同一事务；崩溃整体回滚、下轮扫描重试）
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      const conn: PoolClient = await pool.connect();
      const tx: SqlClient = {
        async query(text: string, values?: readonly unknown[]) {
          const result = await conn.query(text, values as unknown[] | undefined);
          return { rowCount: result.rowCount };
        },
        async queryRows<TResult>(text: string, values?: readonly unknown[]) {
          const result = await conn.query(text, values as unknown[] | undefined);
          return result.rows as TResult[];
        },
      };
      try {
        await conn.query('BEGIN');
        const result = await fn(tx);
        await conn.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await conn.query('ROLLBACK');
        } catch {
          // 连接已坏时忽略回滚失败，原异常优先抛出
        }
        throw error;
      } finally {
        conn.release();
      }
    },
  };
}
