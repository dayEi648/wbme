import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * 部门闭包查询（hr PRD §5/§6、主 PRD §3.1"部门包含部门及全部下级"）。
 *
 * 经 hr.department_closure 只读视图（递归 CTE 含自身；ACTIVE 与 DISABLED 全部参与——
 * 停用不收缩既有数据范围，hr PRD §6）一次 SQL 取闭包。多部门员工按并集计算。
 */
@Injectable()
export class DepartmentClosureService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查询部门 id 集合的闭包（并集，含自身）。
   *
   * @param departmentIds 部门 id 集合
   * @returns 闭包 id 集合（含输入本身与全部下级）
   */
  async closureOf(departmentIds: readonly number[]): Promise<Set<number>> {
    if (departmentIds.length === 0) {
      return new Set<number>();
    }
    const rows = await this.prisma.client.$queryRaw<Array<{ descendant_id: number }>>`
      SELECT DISTINCT descendant_id
      FROM hr.department_closure
      WHERE ancestor_id = ANY(${departmentIds as number[]})
    `;
    return new Set(rows.map((row) => row.descendant_id));
  }

  /**
   * 查询用户全部归属部门的闭包（多部门并集，含下级）。
   *
   * @param userId 用户 id
   * @returns 闭包 id 集合；无部门返回空集合
   */
  async closureOfUser(userId: number): Promise<Set<number>> {
    const rows = await this.prisma.client.$queryRaw<Array<{ department_id: number }>>`
      SELECT department_id
      FROM hr.user_org
      WHERE user_id = ${userId}
    `;
    return this.closureOf(rows.map((row) => row.department_id));
  }
}
