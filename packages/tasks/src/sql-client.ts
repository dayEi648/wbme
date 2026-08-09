/**
 * 原始 SQL 客户端最小接口（Worker 使用 pg Pool，platform-core 可注入 Prisma）。
 */
export interface SqlClient {
  /** 执行写语句 */
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
  /** 执行查询语句 */
  queryRows<T>(text: string, values?: readonly unknown[]): Promise<T[]>;
}
