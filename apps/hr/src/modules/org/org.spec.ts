import 'reflect-metadata';
import { AssetDepartmentClient } from './asset-department.client';

/** asset 跨服务 stub：集成测试不依赖 asset 服务运行时（M12 后部门删除会调用内部接口） */
const assetClientStub = {
  countAssets: async () => 0,
  clearAssignments: async () => undefined,
} as unknown as AssetDepartmentClient;
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameworkErrors, hrErrors } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import { ensurePermissionCatalog } from '../../test-support/ensure-permission-catalog';
import type { HrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { TitleRuleService } from '../title/title-rule.service';
import { DepartmentService } from './department.service';
import { OrgStructureService } from './org-structure.service';
import { PositionService } from './position.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/** 固定测试 id 段（int4 范围内，避免与真实用户冲突） */
const BASE_ID = 8_901_001;

/**
 * 组织模块集成测试（T6-1/T6-2/T6-3）：
 * 部门树维护（创建/停用/删除含下级禁止/循环拒绝）、组织版本递增、
 * 员工多部门编排与岗位适用校验、岗位适用部门修改拒绝、职称规则软删除。
 */
describeDb('组织模块（T6-1/T6-2/T6-3）', () => {
  let prisma: PrismaService;
  let departments: DepartmentService;
  let positions: PositionService;
  let org: OrgStructureService;
  let admin: HrOperationLogOperator;
  let adminUserId = 0;
  let previousHrStatus: string | null = null;
  const createdDepartmentIds: number[] = [];
  const createdPositionIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    departments = new DepartmentService(prisma, assetClientStub);
    positions = new PositionService(prisma);
    org = new OrgStructureService(prisma);
    await ensurePermissionCatalog(prisma);

    // 组织版本行初始化（幂等；CI 全新库 org_meta 为空，测试不依赖执行顺序）
    await prisma.client.orgMeta.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });

    // 打开 HR 系统（测毕还原）
    const statusRows = await prisma.client.$queryRaw<Array<{ product_status: string }>>`
      SELECT product_status::text AS product_status FROM backstage.systems WHERE code = 'HR' LIMIT 1
    `;
    previousHrStatus = statusRows[0]?.product_status ?? null;
    await prisma.client.$executeRaw`UPDATE backstage.systems SET product_status = 'OPEN' WHERE code = 'HR'`;

    // 超管操作人（跨 schema 写 base.users）
    const phone = `+8613900000${String(BASE_ID).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const inserted = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('org测试超管', 'MALE', ${phone}, 'ACTIVE', true, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    adminUserId = inserted[0]!.id;
    admin = { id: adminUserId, name: 'org测试超管', departments: [] };
  });

  afterAll(async () => {
    if (createdPositionIds.length > 0) {
      await prisma.client.positionDepartment.deleteMany({ where: { positionId: { in: createdPositionIds } } });
      await prisma.client.position.deleteMany({ where: { id: { in: createdPositionIds } } });
    }
    await prisma.client.userDepartment.deleteMany({ where: { departmentId: { in: createdDepartmentIds } } });
    await prisma.client.department.deleteMany({ where: { id: { in: createdDepartmentIds } } });
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${adminUserId}`;
    if (previousHrStatus !== null) {
      await prisma.client.$executeRaw`
        UPDATE backstage.systems SET product_status = ${previousHrStatus}::backstage."ProductStatus" WHERE code = 'HR'
      `;
    }
    await prisma.client.$disconnect();
  });

  it('部门创建/停用/删除：树结构变更递增 org_tree_version；停用后不可作为新下级目标', async () => {
    const before = await prisma.client.$queryRaw<Array<{ v: number }>>`SELECT org_tree_version AS v FROM hr.org_meta`;
    const created = await departments.create(admin, { name: '测试部门A', sort: 1 });
    createdDepartmentIds.push(created.id);
    const rootId = created.id;
    const child = await departments.create(admin, { name: '测试子部门', parentId: rootId });
    createdDepartmentIds.push(child.id);
    const after = await prisma.client.$queryRaw<Array<{ v: number }>>`SELECT org_tree_version AS v FROM hr.org_meta`;
    expect(Number(after[0]!.v)).toBeGreaterThan(Number(before[0]!.v ?? 0) + 1);

    // 停用父部门后不可作为新建下级目标
    await departments.update(admin, rootId, { status: 'DISABLED' });
    await expect(departments.create(admin, { name: '非法下级', parentId: rootId })).rejects.toMatchObject({
      entry: { code: frameworkErrors.VALIDATION_FAILED.code },
    });

    // 有未删除下级时禁止删除
    await expect(departments.deleteBatch(admin, [rootId])).rejects.toMatchObject({
      entry: { code: hrErrors.DEPARTMENT_HAS_CHILDREN.code },
    });
  });

  it('组织关系调整不能形成循环（ORGANIZATION_CYCLE）', async () => {
    const a = await departments.create(admin, { name: '循环A' });
    const b = await departments.create(admin, { name: '循环B', parentId: a.id });
    createdDepartmentIds.push(a.id, b.id);
    // 把 A 移到 B 之下形成环
    await expect(departments.move(admin, a.id, b.id)).rejects.toMatchObject({
      entry: { code: hrErrors.ORGANIZATION_CYCLE.code },
    });
  });

  it('员工多部门编排：岗位须适用于全部新部门（POSITION_DEPARTMENT_MISMATCH）', async () => {
    const deptA = await departments.create(admin, { name: '编排部门A' });
    const deptB = await departments.create(admin, { name: '编排部门B' });
    createdDepartmentIds.push(deptA.id, deptB.id);
    const position = await positions.create(admin, { name: '测试岗位X', departmentIds: [deptA.id] });
    createdPositionIds.push(position.id);

    // 目标员工（普通员工）
    const phone = `+8613900000${String(BASE_ID + 1).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const employee = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('org测试员工', 'MALE', ${phone}, 'ACTIVE', false, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    const employeeId = employee[0]!.id;
    try {
      // 先给岗位，再编排两个部门：岗位只适用 A → 拒绝
      await org.assignPosition(admin, employeeId, position.id);
      await expect(org.assignDepartments(admin, employeeId, [deptA.id, deptB.id])).rejects.toMatchObject({
        entry: { code: hrErrors.POSITION_DEPARTMENT_MISMATCH.code },
      });
      // 单部门编排成功；user_org_version 递增
      const before = await prisma.client.$queryRaw<Array<{ v: number }>>`SELECT user_org_version AS v FROM hr.org_meta`;
      await org.assignDepartments(admin, employeeId, [deptA.id]);
      const after = await prisma.client.$queryRaw<Array<{ v: number }>>`SELECT user_org_version AS v FROM hr.org_meta`;
      expect(Number(after[0]!.v)).toBeGreaterThan(Number(before[0]!.v ?? 0));
      const rows = await prisma.client.$queryRaw<Array<{ department_id: number }>>`
        SELECT department_id FROM hr.user_org WHERE user_id = ${employeeId}
      `;
      expect(rows.map((row) => row.department_id)).toEqual([deptA.id]);
      const employeeList = await org.listEmployees({
        page: 1,
        pageSize: 20,
        keyword: 'org测试员工',
        departmentId: deptA.id,
        positionId: position.id,
        status: 'ACTIVE',
      });
      expect(employeeList).toMatchObject({
        total: 1,
        items: [{ id: employeeId, userId: employeeId, name: 'org测试员工', status: 'ACTIVE', departmentIds: [deptA.id], positionId: position.id }],
      });
    } finally {
      await prisma.client.userDepartment.deleteMany({ where: { userId: employeeId } });
      await prisma.client.userPosition.deleteMany({ where: { userId: employeeId } });
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${employeeId}`;
    }
  });

  it('修改岗位适用部门：存在不兼容在岗员工时整次拒绝并返回受影响员工', async () => {
    const deptA = await departments.create(admin, { name: '适用部门A' });
    const deptB = await departments.create(admin, { name: '适用部门B' });
    createdDepartmentIds.push(deptA.id, deptB.id);
    // 岗位 Z 同时适用于 A、B
    const position = await positions.create(admin, { name: '测试岗位Z', departmentIds: [deptA.id, deptB.id] });
    createdPositionIds.push(position.id);

    const phone = `+8613900000${String(BASE_ID + 2).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const employee = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('org测试员工2', 'MALE', ${phone}, 'ACTIVE', false, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    const employeeId = employee[0]!.id;
    try {
      // 员工属于 A、B 且持有岗位 Z（适用于 A、B）
      await org.assignDepartments(admin, employeeId, [deptA.id, deptB.id]);
      await org.assignPosition(admin, employeeId, position.id);
      // 把 Z 的适用部门改为仅 A → 员工属于 B 且 B 不在新适用集 → 整次拒绝
      await expect(positions.updateDepartments(admin, position.id, [deptA.id])).rejects.toMatchObject({
        entry: { code: hrErrors.POSITION_DEPARTMENT_MISMATCH.code },
      });
      // 适用部门保持原样（整批不变更）
      const applicable = await prisma.client.positionDepartment.findMany({
        where: { positionId: position.id },
        select: { departmentId: true },
      });
      expect(applicable.map((row) => row.departmentId).sort()).toEqual([deptA.id, deptB.id].sort());
    } finally {
      await prisma.client.userDepartment.deleteMany({ where: { userId: employeeId } });
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${employeeId}`;
    }
  });

  it('职称规则批量软删除：软删后不再参与匹配（视图立即反映）', async () => {
    const rule = await prisma.client.titleRule.create({
      data: { titleName: '测试职称', status: 'ACTIVE', sort: 1, createdBy: adminUserId },
    });
    // 命中规则（员工无部门/岗位/角色条件 → 全部条件为空即通用规则）→ 经 user_titles 视图应有职称
    const phone = `+8613900000${String(BASE_ID + 3).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const employee = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('org测试员工3', 'MALE', ${phone}, 'ACTIVE', false, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    const employeeId = employee[0]!.id;
    try {
      const before = await prisma.client.$queryRaw<Array<{ title_name: string | null }>>`
        SELECT title_name FROM hr.user_titles WHERE user_id = ${employeeId}
      `;
      expect(before[0]?.title_name).toBe('测试职称');
      // 软删除
      const rules = new TitleRuleService(prisma);
      await rules.deleteBatch(admin, [rule.id]);
      const after = await prisma.client.$queryRaw<Array<{ title_name: string | null }>>`
        SELECT title_name FROM hr.user_titles WHERE user_id = ${employeeId}
      `;
      expect(after[0]?.title_name ?? null).toBeNull();
    } finally {
      await prisma.client.titleRule.deleteMany({ where: { id: rule.id } });
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${employeeId}`;
    }
  });

  it('批量硬删除部门：清空员工部门关系（员工变无部门）', async () => {
    const dept = await departments.create(admin, { name: '待删部门' });
    createdDepartmentIds.push(dept.id);
    const phone = `+8613900000${String(BASE_ID + 4).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const employee = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('org测试员工4', 'MALE', ${phone}, 'ACTIVE', false, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    const employeeId = employee[0]!.id;
    try {
      await org.assignDepartments(admin, employeeId, [dept.id]);
      const deleted = await departments.deleteBatch(admin, [dept.id]);
      expect(deleted.deleted).toBe(1);
      const rows = await prisma.client.$queryRaw<Array<{ department_id: number }>>`
        SELECT department_id FROM hr.user_org WHERE user_id = ${employeeId}
      `;
      expect(rows.length).toBe(0); // 级联清空 → 无部门员工
    } finally {
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${employeeId}`;
    }
  });
});
