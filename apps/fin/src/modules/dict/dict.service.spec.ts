import { BusinessException, type FinDictItemQueryDto } from '@wbme/contracts';
import { describe, expect, it, vi } from 'vitest';
import { DictService } from './dict.service';

/**
 * 财务字典删除预览（主 PRD §2.6 确认式删除第一段）单测：
 * 逐目标返回被工程合同的引用数（地区/进度/业务分类 id 列 + 资料齐全度 JSONB 数组），
 * 按入参顺序输出；任一目标不存在抛 RESOURCE_NOT_FOUND（不静默吞掉错误目标）。
 */
describe('DictService.deletePreview', () => {
  const mockPrisma = (dictRows: unknown[], countRows: Array<{ id: number; referenced: bigint }>) => ({
    client: {
      financeDictItem: { findMany: vi.fn().mockResolvedValue(dictRows) },
      $queryRaw: vi.fn().mockResolvedValue(countRows),
    },
  });

  it('逐目标返回引用数（按入参顺序，含字典类型）', async () => {
    const prisma = mockPrisma(
      [
        { id: 1, dictType: 'REGION' },
        { id: 2, dictType: 'COMPLETENESS' },
      ],
      [
        { id: 1, referenced: 3n },
        { id: 2, referenced: 1n },
      ],
    );
    const service = new DictService(prisma as never);

    const preview = await service.deletePreview([1, 2]);
    expect(preview.items).toEqual([
      { id: 1, dictType: 'REGION', referencedCount: 3 },
      { id: 2, dictType: 'COMPLETENESS', referencedCount: 1 },
    ]);
  });

  it('无引用时返回 0（不缺失目标）', async () => {
    const prisma = mockPrisma([{ id: 7, dictType: 'PROGRESS' }], []);
    const service = new DictService(prisma as never);

    const preview = await service.deletePreview([7]);
    expect(preview.items).toEqual([{ id: 7, dictType: 'PROGRESS', referencedCount: 0 }]);
  });

  it('任一目标不存在抛 RESOURCE_NOT_FOUND', async () => {
    const prisma = mockPrisma([{ id: 1, dictType: 'REGION' }], []);
    const service = new DictService(prisma as never);

    await expect(service.deletePreview([1, 9])).rejects.toBeInstanceOf(BusinessException);
    await expect(service.deletePreview([1, 9])).rejects.toMatchObject({ entry: { code: 'RESOURCE_NOT_FOUND' } });
  });
});

describe('DictService.list', () => {
  function mockListPrisma() {
    return {
      client: {
        financeDictItem: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    };
  }

  function filtersPayload(conditions: unknown[]) {
    return JSON.stringify({ logic: 'AND', conditions });
  }

  function baseQuery(): Pick<FinDictItemQueryDto, 'page' | 'pageSize'> {
    return { page: 1, pageSize: 20 };
  }

  function captureDictFindManyArgs(prisma: ReturnType<typeof mockListPrisma>): { where?: unknown } {
    return (prisma.client.financeDictItem.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { where?: unknown };
  }

  it('无 filters 时具名 dictType/status 生效', async () => {
    const prisma = mockListPrisma();
    const service = new DictService(prisma as never);
    const query: FinDictItemQueryDto = { ...baseQuery(), dictType: 'PROGRESS', status: 'ACTIVE' };

    await service.list(query);

    expect(prisma.client.financeDictItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dictType: 'PROGRESS', status: 'ACTIVE' },
      }),
    );
  });

  it('filters 树中出现 dictType 时具名 dictType 让位', async () => {
    const prisma = mockListPrisma();
    const service = new DictService(prisma as never);
    const query: FinDictItemQueryDto = {
      ...baseQuery(),
      dictType: 'PROGRESS',
      filters: filtersPayload([{ field: 'dictType', operator: 'EQUALS', value: 'REGION' }]),
    };

    await service.list(query);

    const callArgs = captureDictFindManyArgs(prisma);
    expect(callArgs.where).toEqual({ AND: [{}, { AND: [{ dictType: 'REGION' }] }] });
  });

  it('filters 树中出现 status 时具名 status 让位', async () => {
    const prisma = mockListPrisma();
    const service = new DictService(prisma as never);
    const query: FinDictItemQueryDto = {
      ...baseQuery(),
      status: 'ACTIVE',
      filters: filtersPayload([{ field: 'status', operator: 'EQUALS', value: 'DISABLED' }]),
    };

    await service.list(query);

    const callArgs = captureDictFindManyArgs(prisma);
    expect(callArgs.where).toEqual({ AND: [{}, { AND: [{ status: 'DISABLED' }] }] });
  });
});
