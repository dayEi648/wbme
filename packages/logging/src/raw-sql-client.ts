/**
 * 原始 SQL 客户端最小接口（主 PRD §9.4 跨 schema 写入例外）。
 *
 * 各部署单元通过 Prisma `$executeRawUnsafe` / `$queryRawUnsafe` 或等价实现注入，
 * 共享日志模块不依赖具体 ORM 类型。
 */
export interface RawSqlClient {
  /** 执行写语句，返回受影响行数 */
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  /** 执行查询语句 */
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}
