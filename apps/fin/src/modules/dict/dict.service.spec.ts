import { BusinessException } from '@wbme/contracts';
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
