import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalErrors, ORG_STRUCTURE_FUNCTION_CODE, OVERTIME_APPROVAL_FUNCTION_CODE } from '@wbme/contracts';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { getFunctionAccess, loadSessionUser, loadUserName } from '../../shared/cross-schema-auth';
import type { ApprovalSideEffect } from './approval-side-effect';
import { HrApprovalService } from './hr-approval.service';

/**
 * hr 审批头部门闭包与批准副作用单测（T6 核心逻辑）。
 * 集成用例见 hr-approval.service.spec.ts（真实库：待审批限制/并发冲突）。
 * 本文件 mock 数据库与跨 schema 视图读取，聚焦：
 *  - DEPARTMENT 档列表按闭包裁剪（含空闭包守卫与不可见类型哨兵）；
 *  - 批准/驳回范围断言（SCOPE_NOT_COVERED）；
 *  - 批准副作用注入与事务回滚语义。
 */

vi.mock('../../shared/cross-schema-auth', () => ({
  getFunctionAccess: vi.fn(),
  loadSessionUser: vi.fn(),
  loadUserName: vi.fn(),
}));

const mockedGetAccess = vi.mocked(getFunctionAccess);
const mockedLoadSessionUser = vi.mocked(loadSessionUser);
const mockedLoadUserName = vi.mocked(loadUserName);

/** 审批头（PENDING 状态行） */
const headRow = {
  id: 1,
  applicationNo: 'OV20260801001',
  requestType: 'OVERTIME',
  applicantId: 7,
  applicantName: '申请人',
  applicantDepartmentSnapshot: [{ id: 10, name: '部门十' }],
  proxyId: null,
  proxyName: null,
  status: 'PENDING',
  version: 1,
  submittedAt: new Date(),
  processorId: null,
  processorName: null,
  processedAt: null,
  opinion: null,
  cancelledBy: null,
  cancelledAt: null,
  cancelSource: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 7,
};

type MockFn = ReturnType<typeof vi.fn>;

function makePrisma(overrides: Record<string, unknown> = {}): {
  client: {
    hrApprovalRequest: { findUnique: MockFn; findMany: MockFn; count: MockFn; groupBy: MockFn; updateMany: MockFn; create: MockFn };
    hrApprovalAction: { create: MockFn };
    hrOperationLog: { create: MockFn; findFirst: MockFn };
    overtimeItem: { findMany: MockFn };
    positionChangeRequest: { findUnique: MockFn };
    $queryRaw: MockFn;
    $transaction: MockFn;
  };
} {
  const client = {
    hrApprovalRequest: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(),
    },
    hrApprovalAction: { create: vi.fn() },
    // 审批处理/取消写入 hr 操作日志与幂等记录（批次 3：条目 10/11）
    hrOperationLog: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
    overtimeItem: { findMany: vi.fn().mockResolvedValue([]) },
    positionChangeRequest: { findUnique: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    // 事务回调收到 client 自身（与生产语义一致：tx 与 client 同构）
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    ...overrides,
  };
  return { client };
}

function makeService(prisma: unknown, closure?: Partial<DepartmentClosureService>, sideEffect?: ApprovalSideEffect): HrApprovalService {
  const closureService = {
    closureOfUser: vi.fn().mockResolvedValue(new Set<number>([1, 2])),
    ...closure,
  } as unknown as DepartmentClosureService;
  return new HrApprovalService(prisma as never, closureService, sideEffect ?? null, { redis: {} } as never);
}

/** DEPARTMENT 档可见性：OVERTIME 授予部门档，POSITION_CHANGE 不授予 */
function mockDepartmentAccess(): void {
  mockedGetAccess.mockImplementation(async (_prisma, _userId, code) => ({
    registered: true,
    systemCode: 'HR',
    systemName: 'hr',
    systemOpen: true,
    allowed: code === OVERTIME_APPROVAL_FUNCTION_CODE,
    dataScope: code === OVERTIME_APPROVAL_FUNCTION_CODE ? 'DEPARTMENT' : null,
  }));
}

/** 岗位变更审批为公司档，用于验证其批准副作用；不受部门快照测试干扰。 */
function mockCompanyPositionAccess(): void {
  mockedGetAccess.mockImplementation(async (_prisma, _userId, code) => ({
    registered: true,
    systemCode: 'HR',
    systemName: 'hr',
    systemOpen: true,
    allowed: code === ORG_STRUCTURE_FUNCTION_CODE,
    dataScope: code === ORG_STRUCTURE_FUNCTION_CODE ? 'COMPANY' : null,
  }));
}

describe('HrApprovalService 部门闭包与批准副作用（T6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadSessionUser.mockResolvedValue({ id: 1, isSuperAdmin: false } as never);
    mockedLoadUserName.mockResolvedValue('处理人');
  });

  describe('list：DEPARTMENT 档闭包裁剪', () => {
    it('闭包覆盖的记录 id 进入 where.id 列表，请求类型限定可见类型', async () => {
      mockDepartmentAccess();
      const prisma = makePrisma();
      // 闭包内加班明细记录（request_id 11、22）
      vi.mocked(prisma.client.$queryRaw).mockResolvedValueOnce([{ id: 11 }, { id: 22 }]);
      const service = makeService(prisma);

      const result = await service.list(5, { page: 1, pageSize: 20 });

      expect(prisma.client.hrApprovalRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            requestType: { in: ['OVERTIME'] },
            AND: [
              {
                OR: [{ requestType: 'OVERTIME', id: { in: [11, 22] } }],
              },
            ],
          }),
        }),
      );
      expect(result.total).toBe(0);
    });

    it('空闭包（无部门审批人）返回空列表且不执行 $queryRaw 空数组查询', async () => {
      mockDepartmentAccess();
      const prisma = makePrisma();
      const service = makeService(prisma, { closureOfUser: vi.fn().mockResolvedValue(new Set<number>()) });
      const result = await service.list(5, { page: 1, pageSize: 20 });
      expect(result.items).toEqual([]);
      expect(prisma.client.$queryRaw).not.toHaveBeenCalled();
    });

    it('不可见类型筛选返回空（哨兵 id=-1），不被闭包覆盖', async () => {
      mockDepartmentAccess();
      const prisma = makePrisma();
      vi.mocked(prisma.client.$queryRaw).mockResolvedValueOnce([{ id: 11 }]);
      const service = makeService(prisma);
      // POSITION_CHANGE 未授予（getFunctionAccess 对 POSITION_CHANGE 返回 dataScope null）→ 不可见
      const result = await service.list(5, { requestType: 'POSITION_CHANGE', page: 1, pageSize: 20 });
      expect(prisma.client.hrApprovalRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: -1 }) }),
      );
      expect(result.items).toEqual([]);
    });

    it('无任何可见类型（未授权/系统关闭）直接返回空', async () => {
      mockedGetAccess.mockResolvedValue({
        registered: true,
        systemCode: 'HR',
        systemName: 'hr',
        systemOpen: false,
        allowed: false,
        dataScope: null,
      });
      const service = makeService(makePrisma());
      const result = await service.list(5, { page: 1, pageSize: 20 });
      expect(result.items).toEqual([]);
      expect(service['buildWhere']).toBeDefined();
    });

    it('混合档位：加班 DEPARTMENT 档 + 岗位变更 COMPANY 档，公司档记录不被闭包误裁', async () => {
      // 组织管理员（岗位变更=COMPANY 档）兼部门级加班审批人（加班=DEPARTMENT 档）
      mockedGetAccess.mockImplementation(async (_prisma, _userId, code) => ({
        registered: true,
        systemCode: 'HR',
        systemName: 'hr',
        systemOpen: true,
        allowed: true,
        dataScope: code === OVERTIME_APPROVAL_FUNCTION_CODE ? 'DEPARTMENT' : 'COMPANY',
      }));
      const prisma = makePrisma();
      // 加班闭包覆盖 request_id 11；岗位变更为公司档，不应触发其闭包查询
      vi.mocked(prisma.client.$queryRaw).mockResolvedValueOnce([{ id: 11 }]);
      const service = makeService(prisma);

      const result = await service.list(5, { page: 1, pageSize: 20 });

      expect(prisma.client.hrApprovalRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            requestType: { in: ['OVERTIME', 'POSITION_CHANGE'] },
            AND: [
              {
                OR: [
                  { requestType: 'OVERTIME', id: { in: [11] } },
                  { requestType: 'POSITION_CHANGE' },
                ],
              },
            ],
          }),
        }),
      );
      // 只执行一次闭包查询（仅加班 DEPARTMENT 档）
      expect(prisma.client.$queryRaw).toHaveBeenCalledTimes(1);
      expect(result.total).toBe(0);
    });

    it('混合档位反向：加班 COMPANY 档 + 岗位变更 DEPARTMENT 档，加班记录不被闭包误裁', async () => {
      mockedGetAccess.mockImplementation(async (_prisma, _userId, code) => ({
        registered: true,
        systemCode: 'HR',
        systemName: 'hr',
        systemOpen: true,
        allowed: true,
        dataScope: code === ORG_STRUCTURE_FUNCTION_CODE ? 'DEPARTMENT' : 'COMPANY',
      }));
      const prisma = makePrisma();
      // 岗位变更闭包覆盖 request_id 22；加班为公司档，不触发闭包查询
      vi.mocked(prisma.client.$queryRaw).mockResolvedValueOnce([{ id: 22 }]);
      const service = makeService(prisma);

      await service.list(5, { page: 1, pageSize: 20 });

      expect(prisma.client.hrApprovalRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              {
                OR: [
                  { requestType: 'OVERTIME' },
                  { requestType: 'POSITION_CHANGE', id: { in: [22] } },
                ],
              },
            ],
          }),
        }),
      );
      expect(prisma.client.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('process：范围断言与批准副作用', () => {
    it('DEPARTMENT 档审批人范围未覆盖明细部门 → SCOPE_NOT_COVERED', async () => {
      mockDepartmentAccess();
      const prisma = makePrisma();
      vi.mocked(prisma.client.hrApprovalRequest.findUnique).mockResolvedValue(headRow);
      // 明细快照为数组（与生产一致）：部门 10 不在审批人闭包 {1,2} → 断言失败
      vi.mocked(prisma.client.overtimeItem.findMany).mockResolvedValue([
        { departmentSnapshot: [{ id: 10, name: '部门十' }] } as never,
      ]);
      const service = makeService(prisma);
      await expect(service.process(1, 'APPROVE', 5)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: approvalErrors.SCOPE_NOT_COVERED.code }),
      });
      expect(prisma.client.hrApprovalRequest.updateMany).not.toHaveBeenCalled();
    });

    it('多部门员工快照：任一部门不在闭包即 SCOPE_NOT_COVERED（全部部门须覆盖）', async () => {
      mockDepartmentAccess();
      const prisma = makePrisma();
      vi.mocked(prisma.client.hrApprovalRequest.findUnique).mockResolvedValue(headRow);
      // 员工同时属于部门 1（在闭包）与部门 3（不在闭包）→ 拒绝批准
      vi.mocked(prisma.client.overtimeItem.findMany).mockResolvedValue([
        { departmentSnapshot: [{ id: 1, name: '部门一' }, { id: 3, name: '部门三' }] } as never,
      ]);
      const service = makeService(prisma);
      await expect(service.process(1, 'APPROVE', 5)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: approvalErrors.SCOPE_NOT_COVERED.code }),
      });
    });

    it('DEPARTMENT 档覆盖明细部门时批准成功（updateMany 状态迁移 + 动作写入）', async () => {
      mockDepartmentAccess();
      const prisma = makePrisma();
      vi.mocked(prisma.client.hrApprovalRequest.findUnique).mockResolvedValue(headRow);
      // 明细快照为数组：部门 1 ∈ 审批人闭包 {1,2}
      vi.mocked(prisma.client.overtimeItem.findMany).mockResolvedValue([
        { departmentSnapshot: [{ id: 1, name: '部门一' }] } as never,
      ]);
      const service = makeService(prisma);
      await expect(service.process(1, 'APPROVE', 5, '同意')).resolves.toBeUndefined();
      expect(prisma.client.hrApprovalRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 1, status: 'PENDING', version: 1 }),
        }),
      );
      expect(prisma.client.hrApprovalAction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'APPROVE', actorId: 5 }) }),
      );
    });

    it('加班批准不调用岗位变更副作用，仍完成状态迁移与审批动作写入', async () => {
      mockDepartmentAccess();
      const prisma = makePrisma();
      vi.mocked(prisma.client.hrApprovalRequest.findUnique).mockResolvedValue(headRow);
      vi.mocked(prisma.client.overtimeItem.findMany).mockResolvedValue([
        { departmentSnapshot: [{ id: 1, name: '部门一' }] } as never,
      ]);
      const apply = vi.fn().mockResolvedValue(undefined);
      const sideEffect = { apply } as ApprovalSideEffect;
      const service = makeService(prisma, undefined, sideEffect);

      await service.process(1, 'APPROVE', 5);

      expect(apply).not.toHaveBeenCalled();
      expect(prisma.client.hrApprovalRequest.updateMany).toHaveBeenCalledOnce();
      expect(prisma.client.hrApprovalAction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'APPROVE', actorId: 5 }) }),
      );
    });

    it('岗位变更批准时在事务内调用副作用', async () => {
      mockCompanyPositionAccess();
      const prisma = makePrisma();
      vi.mocked(prisma.client.hrApprovalRequest.findUnique).mockResolvedValue({
        ...headRow,
        requestType: 'POSITION_CHANGE',
      } as never);
      const apply = vi.fn().mockResolvedValue(undefined);
      const sideEffect = { apply } as ApprovalSideEffect;
      const service = makeService(prisma, undefined, sideEffect);

      await service.process(1, 'APPROVE', 5);

      expect(apply).toHaveBeenCalledOnce();
      const [tx, head, processorId] = apply.mock.calls[0] as [unknown, unknown, number];
      expect(head).toMatchObject({ id: 1, requestType: 'POSITION_CHANGE' });
      expect(processorId).toBe(5);
      expect(tx).toBeDefined();
    });

    it('批准副作用抛错 → 状态迁移被回滚（updateMany 不产生审批动作）', async () => {
      mockCompanyPositionAccess();
      const prisma = makePrisma();
      vi.mocked(prisma.client.hrApprovalRequest.findUnique).mockResolvedValue({
        ...headRow,
        requestType: 'POSITION_CHANGE',
      } as never);
      const sideEffect = {
        apply: vi.fn().mockRejectedValue(new Error('前置校验失败：员工已改为多部门')),
      } as ApprovalSideEffect;
      const service = makeService(prisma, undefined, sideEffect);

      // 副作用抛错 → 事务回滚 → 申请保持待审批（updateMany 无落库、无审批动作）
      await expect(service.process(1, 'APPROVE', 5)).rejects.toThrow('前置校验失败');
      expect(prisma.client.hrApprovalAction.create).not.toHaveBeenCalled();
    });

    it('REJECT 不触发副作用', async () => {
      mockDepartmentAccess();
      const prisma = makePrisma();
      vi.mocked(prisma.client.hrApprovalRequest.findUnique).mockResolvedValue(headRow);
      vi.mocked(prisma.client.overtimeItem.findMany).mockResolvedValue([
        { departmentSnapshot: [{ id: 1, name: '部门一' }] } as never,
      ]);
      const apply = vi.fn().mockResolvedValue(undefined);
      const service = makeService(prisma, undefined, { apply } as ApprovalSideEffect);

      await service.process(1, 'REJECT', 5, '不同意');

      expect(apply).not.toHaveBeenCalled();
      expect(prisma.client.hrApprovalAction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'REJECT', opinion: '不同意' }) }),
      );
    });
  });

  describe('detail：DEPARTMENT 档闭包裁剪（POSITION_CHANGE 快照来源为申请快照）', () => {
    /** OVERTIME 与 POSITION_CHANGE 均授予 DEPARTMENT 档 */
    function mockBothDepartmentAccess(): void {
      mockedGetAccess.mockImplementation(async () => ({
        registered: true,
        systemCode: 'HR',
        systemName: 'hr',
        systemOpen: true,
        allowed: true,
        dataScope: 'DEPARTMENT',
      }));
    }

    it('POSITION_CHANGE 详情申请部门不在闭包 → SCOPE_NOT_COVERED', async () => {
      mockBothDepartmentAccess();
      const prisma = makePrisma();
      vi.mocked(prisma.client.hrApprovalRequest.findUnique).mockResolvedValue({
        ...headRow,
        requestType: 'POSITION_CHANGE',
        overtimeItems: [],
        positionChangeRequest: { departmentSnapshot: [{ id: 10, name: '部门十' }] },
        actions: [],
      } as never);
      const service = makeService(prisma);
      await expect(service.getDetail(5, 1)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: approvalErrors.SCOPE_NOT_COVERED.code }),
      });
    });

    it('POSITION_CHANGE 详情申请部门在闭包 → 返回详情', async () => {
      mockBothDepartmentAccess();
      const prisma = makePrisma();
      const positionChangeRequest = { departmentSnapshot: [{ id: 1, name: '部门一' }] };
      vi.mocked(prisma.client.hrApprovalRequest.findUnique).mockResolvedValue({
        ...headRow,
        requestType: 'POSITION_CHANGE',
        overtimeItems: [],
        positionChangeRequest,
        actions: [],
      } as never);
      const service = makeService(prisma);
      await expect(service.getDetail(5, 1)).resolves.toMatchObject({
        detail: positionChangeRequest,
        request: expect.objectContaining({ requestType: 'POSITION_CHANGE' }),
      });
    });
  });

  describe('pendingCount：仅显式授权计数（超管隐式全量不计入）', () => {
    it('超管无显式授权 → total 0，且不读会话、关闭隐式全量放行', async () => {
      mockedGetAccess.mockImplementation(async () => ({
        registered: true,
        systemCode: 'HR',
        systemName: 'hr',
        systemOpen: true,
        allowed: false,
        dataScope: null,
      }));
      const prisma = makePrisma();
      const service = makeService(prisma);
      const result = await service.pendingCount(9);
      expect(result).toEqual({ total: 0, byType: {} });
      expect(prisma.client.hrApprovalRequest.groupBy).not.toHaveBeenCalled();
      // 计数口径不依赖会话超管标记（隐式全量不生效）
      expect(mockedLoadSessionUser).not.toHaveBeenCalled();
      // 计数路径必须关闭超管隐式全量放行（列表/详情保持默认开启）
      for (const call of mockedGetAccess.mock.calls) {
        expect(call[3]).toEqual({ includeImplicitSuperAdmin: false });
      }
    });

    it('超管有显式授权 → 按授权范围计数（未授权类型不计入）', async () => {
      // 显式授权仅覆盖加班（COMPANY 档）；岗位变更未授权
      mockedGetAccess.mockImplementation(async (_prisma, _userId, code) => ({
        registered: true,
        systemCode: 'HR',
        systemName: 'hr',
        systemOpen: true,
        allowed: code === OVERTIME_APPROVAL_FUNCTION_CODE,
        dataScope: code === OVERTIME_APPROVAL_FUNCTION_CODE ? 'COMPANY' : null,
      }));
      const prisma = makePrisma();
      vi.mocked(prisma.client.hrApprovalRequest.groupBy).mockResolvedValue([
        { requestType: 'OVERTIME', _count: { _all: 3 } } as never,
      ]);
      const service = makeService(prisma);
      const result = await service.pendingCount(9);
      expect(result).toEqual({ total: 3, byType: { OVERTIME: 3 } });
      // COMPANY 档不触发闭包裁剪，where 限定已授权类型 + PENDING
      expect(prisma.client.hrApprovalRequest.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'PENDING', requestType: { in: ['OVERTIME'] } },
        }),
      );
    });

    it('普通授权用户口径不变：DEPARTMENT 档按闭包裁剪计数', async () => {
      mockDepartmentAccess();
      const prisma = makePrisma();
      // 闭包内加班明细记录（request_id 11、22）
      vi.mocked(prisma.client.$queryRaw).mockResolvedValueOnce([{ id: 11 }, { id: 22 }]);
      vi.mocked(prisma.client.hrApprovalRequest.groupBy).mockResolvedValue([
        { requestType: 'OVERTIME', _count: { _all: 2 } } as never,
      ]);
      const service = makeService(prisma);
      const result = await service.pendingCount(5);
      expect(result).toEqual({ total: 2, byType: { OVERTIME: 2 } });
      expect(prisma.client.hrApprovalRequest.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'PENDING',
            requestType: { in: ['OVERTIME'] },
            AND: [{ OR: [{ requestType: 'OVERTIME', id: { in: [11, 22] } }] }],
          }),
        }),
      );
    });
  });
});
