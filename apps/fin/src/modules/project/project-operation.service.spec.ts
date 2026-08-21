import { type ProjectOperationQueryDto } from '@wbme/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOperationService } from './project-operation.service';

/** 构造一个可断言最后一个调用参数的 mock Prisma 客户端。 */
function mockPrisma() {
  return {
    client: {
      projectOperation: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  };
}

function filtersPayload(conditions: unknown[]) {
  return JSON.stringify({ logic: 'AND', conditions });
}

function sortsPayload(sort: { field: string; direction: 'ASC' | 'DESC' }) {
  return JSON.stringify([sort]);
}

function baseQuery(): Pick<ProjectOperationQueryDto, 'page' | 'pageSize'> {
  return { page: 1, pageSize: 20 };
}

function captureOperationFindManyArgs(prisma: ReturnType<typeof mockPrisma>): { where?: unknown } {
  return (prisma.client.projectOperation.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { where?: unknown };
}

describe('ProjectOperationService.list', () => {
  it('filters 编译进 where', async () => {
    const prisma = mockPrisma();
    const service = new ProjectOperationService(prisma as never);
    const query: ProjectOperationQueryDto = {
      ...baseQuery(),
      filters: filtersPayload([{ field: 'action', operator: 'EQUALS', value: 'CREATE' }]),
    };

    await service.list(query);

    const callArgs = captureOperationFindManyArgs(prisma);
    expect(callArgs.where).toEqual({
      AND: [{}, { AND: [{ action: 'CREATE' }] }],
    });
  });

  it('sorts 覆盖默认 orderBy', async () => {
    const prisma = mockPrisma();
    const service = new ProjectOperationService(prisma as never);
    const query: ProjectOperationQueryDto = {
      ...baseQuery(),
      sorts: sortsPayload({ field: 'createdAt', direction: 'ASC' }),
    };

    await service.list(query);

    expect(prisma.client.projectOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }],
      }),
    );
  });

  it('无 sorts 时保持默认 createdAt 倒序', async () => {
    const prisma = mockPrisma();
    const service = new ProjectOperationService(prisma as never);
    const query: ProjectOperationQueryDto = { ...baseQuery(), projectId: 1 };

    await service.list(query);

    expect(prisma.client.projectOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }],
      }),
    );
  });

  it('filters 树中出现 projectId 时具名 projectId 让位', async () => {
    const prisma = mockPrisma();
    const service = new ProjectOperationService(prisma as never);
    const query: ProjectOperationQueryDto = {
      ...baseQuery(),
      projectId: 1,
      filters: filtersPayload([{ field: 'projectId', operator: 'NOT_EQUALS', value: '1' }]),
    };

    await service.list(query);

    const callArgs = captureOperationFindManyArgs(prisma);
    expect(callArgs.where).toEqual({ AND: [{}, { AND: [{ projectId: { not: 1 } }] }] });
  });

  it('具名 projectId 生效（filters 未包含 projectId）', async () => {
    const prisma = mockPrisma();
    const service = new ProjectOperationService(prisma as never);
    const query: ProjectOperationQueryDto = { ...baseQuery(), projectId: 5 };

    await service.list(query);

    const callArgs = captureOperationFindManyArgs(prisma);
    expect(callArgs.where).toEqual({ projectId: 5 });
  });

  it('返回形状：projectName 取自 project.name 并剔除 project 对象', async () => {
    const prisma = mockPrisma();
    (prisma.client.projectOperation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        action: 'CREATE',
        operatorName: '张三',
        createdAt: new Date('2026-08-01T00:00:00Z'),
        project: { name: '测试项目' },
      },
    ]);
    const service = new ProjectOperationService(prisma as never);

    const result = await service.list({ ...baseQuery() });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 1,
      action: 'CREATE',
      operatorName: '张三',
      projectName: '测试项目',
    });
    expect((result.items[0] as { project?: unknown }).project).toBeUndefined();
    // 实际 HTTP 响应对 undefined 字段序列化后不会包含 project
    expect(JSON.parse(JSON.stringify(result.items[0]))).not.toHaveProperty('project');
  });
});
