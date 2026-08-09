/**
 * 原始 SQL 客户端最小接口（Worker 超时扫描使用；与 @wbme/tasks SqlClient 同构）。
 */
export interface SqlClient {
  /** 执行写语句 */
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
  /** 执行查询语句 */
  queryRows<T>(text: string, values?: readonly unknown[]): Promise<T[]>;
}
