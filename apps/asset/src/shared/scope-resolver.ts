import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { assertFunctionAccess } from './cross-schema-auth';
import { DepartmentClosureService } from './department-closure.service';

/**
 * 历史记录数据范围解析（asset PRD 各"历史记录"功能：部门/公司档）。
 *
 * - DEPARTMENT：授权部门闭包内全部在职员工（hr.user_org 归属部门 ∩ 闭包）；
 * - COMPANY / 超管（dataScope=null）：全部在职员工（backstage.user_accounts 视图）；
 * - 返回的 userId 集合用于申请人过滤；空集合 = 无可见记录。
 */
@Injectable()
export class ScopeResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly closures: DepartmentClosureService,
  ) {}

  /**
   * 解析范围内在职员工 id 集合（功能授权断言内含）。
   *
   * @param userId 当前用户
   * @param functionCode 历史记录功能编码
   * @returns 员工 id 集合（空 = 无可见记录）
   */
  async resolveHistoryUserIds(userId: number, functionCode: string): Promise<Set<number>> {
    const access = await assertFunctionAccess(this.prisma.client, userId, functionCode);
    if (access.dataScope === null || access.dataScope === 'COMPANY') {
      const rows = await this.prisma.client.$queryRaw<Array<{ user_id: number }>>`
        SELECT user_id FROM backstage.user_accounts WHERE status = 'ACTIVE' AND deleted_at IS NULL
      `;
      return new Set(rows.map((row) => row.user_id));
    }
    const closure = await this.closures.closureOfUser(userId);
    if (closure.size === 0) {
      return new Set<number>();
    }
    const rows = await this.prisma.client.$queryRaw<Array<{ user_id: number }>>`
      SELECT DISTINCT user_id
      FROM hr.user_org
      WHERE department_id = ANY(${[...closure] as number[]})
    `;
    return new Set(rows.map((row) => row.user_id));
  }
}
