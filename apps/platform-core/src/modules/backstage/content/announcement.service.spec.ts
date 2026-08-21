import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { frameworkErrors } from '@wbme/contracts';
import { Prisma } from '../../../generated/prisma/client';
import { AnnouncementService } from './announcement.service';
import { executeIdempotentOperation, loadOperationLogOperator } from '../permission/operation-log.util';

/** executeIdempotentOperation 直通 run（幂等表/操作日志由集成测试覆盖），loadOperationLogOperator 返回固定操作人 */
vi.mock('../permission/operation-log.util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../permission/operation-log.util')>();
  return {
    ...actual,
    loadOperationLogOperator: vi.fn().mockResolvedValue({ id: 1, name: '操作人' }),
    // 直通 run 并把调用方的 client 作为事务客户端传入（run 内使用 tx.announcement 等）
    executeIdempotentOperation: vi.fn(async (client: unknown, options: { run: (tx: unknown) => Promise<unknown> }) =>
      options.run(client),
    ),
  };
});

const mockedExec = vi.mocked(executeIdempotentOperation);
const mockedLoadOperator = vi.mocked(loadOperationLogOperator);

type MockFn = ReturnType<typeof vi.fn>;

function prismaMock(txOverrides: Record<string, unknown> = {}): {
  client: {
    announcement: { findMany: MockFn; count: MockFn; findFirst: MockFn; update: MockFn; updateMany: MockFn; create: MockFn };
    $transaction: MockFn;
  };
} {
  const client = {
    announcement: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    // 事务回调收到 client 自身（与生产语义一致：tx 与 client 同构）
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    ...txOverrides,
  };
  return { client };
}

const draftRow = { id: 1, title: '系统维护公告', content: '内容', status: 'DRAFT', createdBy: 1, updatedBy: 1 };
const publishingRow = { id: 2, title: '展示中公告', content: '内容', status: 'PUBLISHING', createdBy: 1, updatedBy: 1 };

const upsertDto = { title: '系统维护公告', content: '内容', idempotencyKey: 'k-1' };

describe('AnnouncementService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('默认不含已软删，按更新时间倒序分页', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findMany).mockResolvedValue([draftRow]);
      vi.mocked(prisma.client.announcement.count).mockResolvedValue(5);
      const result = await new AnnouncementService(prisma as never).list({ page: 2, pageSize: 10 }) as {
        pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
      };
      expect(prisma.client.announcement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null }, skip: 10, take: 10 }),
      );
      expect(result.pagination).toEqual({ page: 2, pageSize: 10, totalItems: 5, totalPages: 1 });
    });

    it('status 过滤透传', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findMany).mockResolvedValue([]);
      vi.mocked(prisma.client.announcement.count).mockResolvedValue(0);
      await new AnnouncementService(prisma as never).list({ page: 1, pageSize: 20, status: 'PUBLISHING' });
      expect(prisma.client.announcement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null, status: 'PUBLISHING' } }),
      );
    });

    it('结构化筛选 status EQUALS 与 NOT_EQUALS 生效', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findMany).mockResolvedValue([]);
      vi.mocked(prisma.client.announcement.count).mockResolvedValue(0);
      await new AnnouncementService(prisma as never).list({
        page: 1,
        pageSize: 20,
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [{ field: 'status', operator: 'EQUALS', value: 'DRAFT' }],
        }),
      });
      const call = vi.mocked(prisma.client.announcement.findMany).mock.calls[0]![0] as {
        where: { deletedAt: null; AND: Array<{ AND: Array<Record<string, unknown>> }> };
      };
      expect(call.where).toMatchObject({
        deletedAt: null,
        AND: [{ AND: [{ status: 'DRAFT' }] }],
      });
    });

    it('结构化筛选覆盖 status 时具名 status 让位', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findMany).mockResolvedValue([]);
      vi.mocked(prisma.client.announcement.count).mockResolvedValue(0);
      await new AnnouncementService(prisma as never).list({
        page: 1,
        pageSize: 20,
        status: 'PUBLISHING',
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [{ field: 'status', operator: 'EQUALS', value: 'DRAFT' }],
        }),
      });
      const call = vi.mocked(prisma.client.announcement.findMany).mock.calls[0]![0] as {
        where: { status?: string; deletedAt: null; AND: Array<{ AND: Array<Record<string, unknown>> }> };
      };
      expect(call.where.status).toBeUndefined();
      expect(call.where).toMatchObject({
        deletedAt: null,
        AND: [{ AND: [{ status: 'DRAFT' }] }],
      });
    });

    it('title 筛选与 publishedAt 排序进入 Prisma 查询', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findMany).mockResolvedValue([]);
      vi.mocked(prisma.client.announcement.count).mockResolvedValue(0);
      await new AnnouncementService(prisma as never).list({
        page: 1,
        pageSize: 20,
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [{ field: 'title', operator: 'CONTAINS', value: '维护' }],
        }),
        sorts: JSON.stringify([{ field: 'publishedAt', direction: 'ASC' }]),
      });
      const call = vi.mocked(prisma.client.announcement.findMany).mock.calls[0]![0] as {
        where: Record<string, unknown>;
        orderBy: Array<Record<string, string>>;
      };
      expect(call.orderBy).toEqual([{ publishedAt: 'asc' }]);
      expect(call.where).toMatchObject({
        deletedAt: null,
        AND: [{ AND: [{ title: { contains: '维护', mode: 'insensitive' } }] }],
      });
    });
  });

  describe('create', () => {
    it('创建 DRAFT 草稿并写 CREATE 操作日志', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.create).mockResolvedValue(draftRow);
      const result = (await new AnnouncementService(prisma as never).create(1, upsertDto)) as { result: { id: number } };
      expect(result.result.id).toBe(1);
      expect(prisma.client.announcement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DRAFT', title: '系统维护公告', createdBy: 1 }),
        }),
      );
      expect(mockedExec).toHaveBeenCalledOnce();
      expect(mockedLoadOperator).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('不存在时抛 RESOURCE_NOT_FOUND', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findFirst).mockResolvedValue(null);
      await expect(new AnnouncementService(prisma as never).update(1, 99, upsertDto)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: frameworkErrors.RESOURCE_NOT_FOUND.code }),
      });
    });

    it('展示中的公告拒绝编辑（VALIDATION_FAILED）', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findFirst).mockResolvedValue(publishingRow);
      await expect(new AnnouncementService(prisma as never).update(1, 2, upsertDto)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: frameworkErrors.VALIDATION_FAILED.code }),
      });
      expect(prisma.client.announcement.update).not.toHaveBeenCalled();
    });

    it('草稿可编辑并写 UPDATE 日志', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findFirst).mockResolvedValue(draftRow);
      vi.mocked(prisma.client.announcement.update).mockResolvedValue({ ...draftRow, title: '新标题' });
      const result = (await new AnnouncementService(prisma as never).update(1, 1, { ...upsertDto, title: '新标题' })) as {
        result: { id: number };
      };
      expect(result.result.id).toBe(1);
      expect(mockedExec.mock.calls[0]![1]).toMatchObject({ scope: 'announcements.update' });
    });
  });

  describe('publish', () => {
    it('先撤回其它 PUBLISHING 再发布目标，写 UPDATE 日志', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findFirst).mockResolvedValue(publishingRow);
      vi.mocked(prisma.client.announcement.update).mockResolvedValue({ ...publishingRow, publishedAt: new Date(), publisherId: 1 });
      const result = (await new AnnouncementService(prisma as never).publish(1, 2, 'k-2')) as { result: { id: number; status: string } };
      expect(result.result.status).toBe('PUBLISHING');
      // 撤回其它展示中公告（排除目标自身）
      expect(prisma.client.announcement.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'PUBLISHING', id: { not: 2 } }) }),
      );
    });

    it('并发撞部分唯一索引（P2002）映射为 CONFLICT', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findFirst).mockResolvedValue(publishingRow);
      vi.mocked(prisma.client.announcement.update).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique violation', {
          code: 'P2002',
          clientVersion: '7.9.1',
        }),
      );
      await expect(new AnnouncementService(prisma as never).publish(1, 2, 'k-3')).rejects.toMatchObject({
        entry: expect.objectContaining({ code: frameworkErrors.CONFLICT.code }),
      });
    });
  });

  describe('revoke', () => {
    it('展示中公告撤回为 REVOKED', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findFirst).mockResolvedValue(publishingRow);
      vi.mocked(prisma.client.announcement.update).mockResolvedValue({ ...publishingRow, status: 'REVOKED' });
      const result = (await new AnnouncementService(prisma as never).revoke(1, 2, 'k-4')) as { result: { status: string } };
      expect(result.result.status).toBe('REVOKED');
    });

    it('不存在时抛 RESOURCE_NOT_FOUND', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findFirst).mockResolvedValue(null);
      await expect(new AnnouncementService(prisma as never).revoke(1, 99, 'k-5')).rejects.toMatchObject({
        entry: expect.objectContaining({ code: frameworkErrors.RESOURCE_NOT_FOUND.code }),
      });
    });
  });

  describe('batchDelete', () => {
    it('批量软删：deletedAt/deletedBy 落库并置 REVOKED', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findMany).mockResolvedValue([{ id: 1 }, { id: 2 }]);
      vi.mocked(prisma.client.announcement.updateMany).mockResolvedValue({ count: 2 });
      const result = (await new AnnouncementService(prisma as never).batchDelete(1, {
        ids: [1, 2],
        idempotencyKey: 'k-6',
      })) as { result: { deleted: number } };
      expect(result.result.deleted).toBe(2);
      expect(prisma.client.announcement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: [1, 2] }, deletedAt: null }) }),
      );
      expect(prisma.client.announcement.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: [1, 2] } }),
          data: expect.objectContaining({ status: 'REVOKED', deletedBy: 1 }),
        }),
      );
    });

    it('批量软删：目标不存在或已删除 → 整批回滚并返回缺失明细', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.announcement.findMany).mockResolvedValue([{ id: 1 }]);
      const promise = new AnnouncementService(prisma as never).batchDelete(1, {
        ids: [1, 2],
        idempotencyKey: 'k-7',
      });
      await expect(promise).rejects.toMatchObject({
        entry: { code: frameworkErrors.VALIDATION_FAILED.code },
        details: { fields: [{ id: 2, reason: '公告不存在或已删除' }] },
      });
      expect(prisma.client.announcement.updateMany).not.toHaveBeenCalled();
    });
  });
});
