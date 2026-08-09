/**
 * 原始 SQL 客户端最小接口（Worker 超时扫描使用；与 @wbme/tasks SqlClient 同构）。
 */
export interface SqlClient {
  /** 执行写语句 */
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
  /** 执行查询语句 */
  queryRows<T>(text: string, values?: readonly unknown[]): Promise<T[]>;
  /**
   * 事务执行（可选能力）：实现 BEGIN/COMMIT/ROLLBACK 绑定单连接；
   * 未实现时超时扫描按无事务回退（状态迁移与占用释放存在窗口不一致，不建议生产使用）。
   */
  transaction?<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
