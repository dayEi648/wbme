import { type ProjectQueryDto } from '@wbme/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProjectService } from './project.service';

function mockPrisma() {
  return {
    client: {
      project: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      invoice: { findMany: vi.fn().mockResolvedValue([]) },
      receipt: { findMany: vi.fn().mockResolvedValue([]) },
      subcontractPayment: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

function filtersPayload(conditions: unknown[]) {
  return JSON.stringify({ logic: 'AND', conditions });
}

function baseQuery(): Pick<ProjectQueryDto, 'page' | 'pageSize'> {
  return { page: 1, pageSize: 20 };
}

function captureProjectFindManyArgs(prisma: ReturnType<typeof mockPrisma>): { where?: unknown } {
  return (prisma.client.project.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { where?: unknown };
}

describe('ProjectService.list', () => {
  it('无 filters 时具名查询参数生效', async () => {
    const prisma = mockPrisma();
    const service = new ProjectService(prisma as never);
    const query: ProjectQueryDto = {
      ...baseQuery(),
      name: '测试项目',
      partyA: '甲方',
      year: 2026,
      regionId: 1,
      bizCategoryId: 2,
      progressId: 3,
    };

    await service.list(query, false);

    expect(prisma.client.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          businessKey: { contains: '测试项目' },
          partyA: { contains: '甲方' },
          year: 2026,
          regionId: 1,
          bizCategoryId: 2,
          progressId: 3,
        },
      }),
    );
  });

  it('filters 树中出现字段时对应具名参数让位', async () => {
    const prisma = mockPrisma();
    const service = new ProjectService(prisma as never);
    const query: ProjectQueryDto = {
      ...baseQuery(),
      name: 'IGNORE',
      partyA: 'IGNORE',
      year: 2026,
      regionId: 1,
      bizCategoryId: 2,
      progressId: 3,
      filters: filtersPayload([
        { field: 'name', operator: 'CONTAINS', value: '树内名称' },
        { field: 'partyA', operator: 'CONTAINS', value: '树内甲方' },
        { field: 'year', operator: 'EQUALS', value: '2025' },
        { field: 'regionId', operator: 'EQUALS', value: '10' },
        { field: 'bizCategoryId', operator: 'EQUALS', value: '20' },
        { field: 'progressId', operator: 'EQUALS', value: '30' },
      ]),
    };

    await service.list(query, false);

    const callArgs = captureProjectFindManyArgs(prisma);
    expect(callArgs.where).toEqual({
      AND: [
        { deletedAt: null },
        {
          AND: [
            { name: { contains: '树内名称', mode: 'insensitive' } },
            { partyA: { contains: '树内甲方', mode: 'insensitive' } },
            { year: 2025 },
            { regionId: 10 },
            { bizCategoryId: 20 },
            { progressId: 30 },
          ],
        },
      ],
    });
  });
});
