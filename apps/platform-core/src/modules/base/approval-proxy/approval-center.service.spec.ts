import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCenterService } from './approval-center.service';

/** mock @wbme/server 的导出函数 */
vi.mock('@wbme/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wbme/server')>();
  return {
    ...actual,
    runExport: vi.fn().mockResolvedValue(undefined),
  };
});

import { runExport } from '@wbme/server';
import { writeBackstageOperationLog } from '../../backstage/permission/operation-log.util';

vi.mock('../../backstage/permission/operation-log.util', () => ({
  loadOperationLogOperator: vi.fn().mockResolvedValue({ id: 1, name: '操作人' }),
  writeBackstageOperationLog: vi.fn().mockResolvedValue(undefined),
}));

const mockedRunExport = vi.mocked(runExport);
const mockedWriteLog = vi.mocked(writeBackstageOperationLog);

type MockFn = ReturnType<typeof vi.fn>;

function prismaMock(): {
  client: {
    approvalRequest: { count: MockFn; findMany: MockFn };
    $transaction: MockFn;
  };
} {
  return {
    client: {
      approvalRequest: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
  };
}

function service(prisma: unknown): ApprovalCenterService {
  return new ApprovalCenterService(
    prisma as never,
    { redis: {} } as never,
    { getNumber: vi.fn().mockResolvedValue(100) } as never,
  );
}

describe('ApprovalCenterService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('默认限制为 PROFILE_CHANGE 并按 submittedAt/id 倒序', async () => {
      const prisma = prismaMock();
      await service(prisma).list({ page: 1, pageSize: 20 });
      expect(prisma.client.approvalRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { requestType: 'PROFILE_CHANGE' },
          orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('结构化筛选 status EQUALS 生效', async () => {
      const prisma = prismaMock();
      await service(prisma).list({
        page: 1,
        pageSize: 20,
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [{ field: 'status', operator: 'EQUALS', value: 'APPROVED' }],
        }),
      });
      const call = vi.mocked(prisma.client.approvalRequest.findMany).mock.calls[0]![0] as {
        where: { requestType: string; AND: Array<{ AND: Array<Record<string, unknown>> }> };
      };
      expect(call.where.requestType).toBe('PROFILE_CHANGE');
      expect(call.where.AND).toHaveLength(1);
      expect(call.where.AND[0]).toEqual({ AND: [{ status: 'APPROVED' }] });
    });

    it('结构化筛选 keyword 多列 contains（单号/申请人/处理人）', async () => {
      const prisma = prismaMock();
      await service(prisma).list({
        page: 1,
        pageSize: 20,
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [{ field: 'keyword', operator: 'CONTAINS', value: 'AP-2026' }],
        }),
      });
      const call = vi.mocked(prisma.client.approvalRequest.findMany).mock.calls[0]![0] as {
        where: { AND: Array<{ AND: Array<{ OR: Array<Record<string, unknown>> }> }> };
      };
      expect(call.where.AND).toHaveLength(1);
      const keywordWhere = call.where.AND[0]!.AND[0]!;
      expect(keywordWhere.OR).toEqual(
        expect.arrayContaining([
          { applicationNo: { contains: 'AP-2026', mode: 'insensitive' } },
          { applicantName: { contains: 'AP-2026', mode: 'insensitive' } },
          { processorName: { contains: 'AP-2026', mode: 'insensitive' } },
        ]),
      );
    });

    it('结构化筛选覆盖 status/keyword/requestType 时具名参数让位', async () => {
      const prisma = prismaMock();
      await service(prisma).list({
        page: 1,
        pageSize: 20,
        status: 'PENDING',
        keyword: 'ignored',
        requestType: 'IGNORED_TYPE',
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [
            { field: 'status', operator: 'EQUALS', value: 'APPROVED' },
            { field: 'keyword', operator: 'CONTAINS', value: 'AP-001' },
            { field: 'requestType', operator: 'EQUALS', value: 'PROFILE_CHANGE' },
          ],
        }),
      });
      const call = vi.mocked(prisma.client.approvalRequest.findMany).mock.calls[0]![0] as {
        where: { id?: number; status?: string; requestType: string; AND: Array<Record<string, unknown>> };
      };
      // 具名 requestType=IGNORED_TYPE 被忽略，不强制空集
      expect(call.where.id).toBeUndefined();
      // 具名 status=PENDING 被忽略
      expect(call.where.status).toBeUndefined();
      // 结构化筛选以 AND 合并
      expect(call.where.AND).toHaveLength(1);
    });

    it('无 filters 时具名 PROCESSED 虚拟状态映射为 APPROVED/REJECTED/CANCELLED', async () => {
      const prisma = prismaMock();
      await service(prisma).list({ page: 1, pageSize: 20, status: 'PROCESSED' });
      const call = vi.mocked(prisma.client.approvalRequest.findMany).mock.calls[0]![0] as {
        where: { status: { in: string[] } };
      };
      expect(call.where.status).toEqual({ in: ['APPROVED', 'REJECTED', 'CANCELLED'] });
    });

    it('无 filters 时非本模块 requestType 强制空集', async () => {
      const prisma = prismaMock();
      await service(prisma).list({ page: 1, pageSize: 20, requestType: 'OTHER' });
      const call = vi.mocked(prisma.client.approvalRequest.findMany).mock.calls[0]![0] as {
        where: { id: number; requestType: string };
      };
      expect(call.where).toMatchObject({ id: -1, requestType: 'PROFILE_CHANGE' });
    });
  });

  describe('export', () => {
    it('调用 runExport 并复用列表同一 where/orderBy', async () => {
      const prisma = prismaMock();
      await service(prisma).export(1, {
        page: 1,
        pageSize: 20,
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [{ field: 'status', operator: 'EQUALS', value: 'APPROVED' }],
        }),
      }, {} as never);

      expect(mockedRunExport).toHaveBeenCalledOnce();
      const options = mockedRunExport.mock.calls[0]![0];
      expect(options.fetchCount).toBeDefined();
      expect(options.fetchRows).toBeDefined();
      expect(mockedWriteLog).toHaveBeenCalledOnce();
    });
  });
});
