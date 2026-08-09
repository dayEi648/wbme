import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationLogService } from './operation-log.service';

/** mock @wbme/server 的模块函数（守卫上下文与导出） */
vi.mock('@wbme/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wbme/server')>();
  return {
    ...actual,
    getGrantedFunction: vi.fn(),
    getRequestContext: vi.fn(),
    runExport: vi.fn().mockResolvedValue(undefined),
  };
});

import { getGrantedFunction, getRequestContext, runExport } from '@wbme/server';
import { writeBackstageOperationLog, loadOperationLogOperator } from '../permission/operation-log.util';

vi.mock('../permission/operation-log.util', () => ({
  loadOperationLogOperator: vi.fn().mockResolvedValue({ id: 1, name: '操作人' }),
  writeBackstageOperationLog: vi.fn().mockResolvedValue(undefined),
}));

const mockedGranted = vi.mocked(getGrantedFunction);
const mockedContext = vi.mocked(getRequestContext);
const mockedRunExport = vi.mocked(runExport);
const mockedWriteLog = vi.mocked(writeBackstageOperationLog);

type MockFn = ReturnType<typeof vi.fn>;

function prismaMock(): {
  client: { $queryRawUnsafe: MockFn; $queryRaw: MockFn; $transaction: MockFn };
} {
  return {
    client: {
      $queryRawUnsafe: vi.fn(),
      $queryRaw: vi.fn(),
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
  };
}

function makeService(prisma: unknown): OperationLogService {
  return new OperationLogService(
    prisma as never,
    { redis: {} } as never,
    { getNumber: vi.fn().mockResolvedValue(100) } as never,
  );
}

const row = {
  id: 1,
  operator_id: 7,
  operator_name: '张三',
  operator_departments: [{ id: 2, name: '部门二' }],
  system: 'hr',
  feature: 'overtime_submit',
  action_type: 'CREATE',
  summary: '提交加班',
  request_id: 'req-1',
  created_at: new Date('2026-08-01T00:00:00Z'),
};

describe('OperationLogService', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockedGranted.mockReset();
    mockedContext.mockReset();
  });

  describe('list', () => {
    it('分页映射与排序参数正确（$queryRawUnsafe 收到 limit/offset）', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.$queryRawUnsafe)
        .mockResolvedValueOnce([row])
        .mockResolvedValueOnce([{ total: 21n }]);
      const result = await makeService(prisma).list({ page: 2, pageSize: 10 });

      expect(result.data[0]).toMatchObject({
        id: 1,
        operatorId: 7,
        operatorName: '张三',
        system: 'hr',
        actionType: 'CREATE',
        createdAt: row.created_at,
      });
      expect(result.pagination).toEqual({ page: 2, pageSize: 10, totalItems: 21, totalPages: 3 });
      // 列表 SQL 参数：[...filters, pageSize, offset]
      const listArgs = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]!;
      expect(listArgs.slice(1)).toEqual([10, 10]);
    });

    it('逐项过滤条件追加到 WHERE（operatorId/system/feature/actionType/时间范围）', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.$queryRawUnsafe).mockResolvedValueOnce([row]).mockResolvedValueOnce([{ total: 0n }]);
      await makeService(prisma).list({
        page: 1,
        pageSize: 20,
        operatorId: 7,
        system: 'hr',
        feature: 'overtime_submit',
        actionType: 'CREATE',
        from: new Date('2026-08-01T00:00:00Z'),
        to: new Date('2026-08-02T00:00:00Z'),
      });
      const sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      expect(sql).toContain('operator_id = $1');
      expect(sql).toContain('system = $2');
      expect(sql).toContain('feature = $3');
      expect(sql).toContain('action_type = $4');
      expect(sql).toContain('created_at >= $5');
      expect(sql).toContain('created_at <= $6');
    });

    it('COMPANY 档不追加数据范围过滤', async () => {
      mockedGranted.mockReturnValue({ code: 'operation_log_view', dataScope: 'COMPANY' });
      const prisma = prismaMock();
      vi.mocked(prisma.client.$queryRawUnsafe).mockResolvedValueOnce([row]).mockResolvedValueOnce([{ total: 0n }]);
      await makeService(prisma).list({ page: 1, pageSize: 20 });
      const sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      expect(sql).not.toContain('department_closure');
      expect(sql).not.toContain('1 = 0');
    });

    it('DEPARTMENT 档按部门闭包求交集；无部门员工时返回 1=0 空集', async () => {
      mockedGranted.mockReturnValue({ code: 'operation_log_view', dataScope: 'DEPARTMENT' });
      mockedContext.mockReturnValue({ userId: 7 } as never);
      const prisma = prismaMock();
      // 闭包查询返回空 → 1 = 0
      vi.mocked(prisma.client.$queryRaw).mockResolvedValueOnce([]);
      vi.mocked(prisma.client.$queryRawUnsafe).mockResolvedValueOnce([row]).mockResolvedValueOnce([{ total: 0n }]);
      await makeService(prisma).list({ page: 1, pageSize: 20 });
      let sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      expect(sql).toContain('1 = 0');

      // 闭包有行 → EXISTS 交集过滤
      vi.mocked(prisma.client.$queryRawUnsafe).mockReset().mockResolvedValueOnce([row]).mockResolvedValueOnce([{ total: 0n }]);
      vi.mocked(prisma.client.$queryRaw).mockResolvedValueOnce([
        { descendant_id: 2 },
        { descendant_id: 5 },
      ]);
      await makeService(prisma).list({ page: 1, pageSize: 20 });
      sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('operator_departments');
      const args = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]!.slice(1) as [number, unknown[]][];
      // 参数含闭包 id 数组：WHERE 参数列表 + [pageSize, offset]
      expect(args[0]).toEqual([2, 5]);
    });
  });

  describe('listMine', () => {
    it('以当前用户 operatorId 过滤', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.$queryRawUnsafe).mockResolvedValue([]).mockResolvedValueOnce([]);
      await makeService(prisma).listMine(42, { page: 1, pageSize: 20 });
      const sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      expect(sql).toContain('operator_id = $1');
      expect(vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![1]).toBe(42);
    });
  });

  describe('export', () => {
    it('调用 runExport 并在完成后写 EXPORT 操作日志', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.$queryRawUnsafe).mockResolvedValue([]);
      const settings = { getNumber: vi.fn().mockResolvedValue(500) };
      const service = new OperationLogService(prisma as never, { redis: {} } as never, settings as never);
      await service.export(7, {}, {} as never);

      expect(mockedRunExport).toHaveBeenCalledOnce();
      expect(mockedRunExport.mock.calls[0]![0]).toMatchObject({ userId: 7, maxRows: 500, filename: 'operation-logs.xlsx' });
      expect(mockedWriteLog).toHaveBeenCalledOnce();
      expect(mockedWriteLog.mock.calls[0]![1]).toMatchObject({ actionType: 'EXPORT', summary: '导出操作日志' });
      expect(loadOperationLogOperator).toHaveBeenCalled();
    });
  });
});
