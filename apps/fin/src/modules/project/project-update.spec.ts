import { BusinessException } from '@wbme/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProjectService, mergeProjectUpdateDto } from './project.service';

describe('mergeProjectUpdateDto', () => {
  const baseDto = { name: '测试项目', year: 2026 };

  it('未提交分包方时保留已保存的值', () => {
    expect(mergeProjectUpdateDto(baseDto, ['分包方甲', '分包方乙']).subcontractors).toEqual(['分包方甲', '分包方乙']);
  });

  it('显式空数组保留清空意图', () => {
    expect(mergeProjectUpdateDto({ ...baseDto, subcontractors: [] }, ['分包方甲']).subcontractors).toEqual([]);
  });

  it('资料齐全度拒绝非 COMPLETENESS 类型的字典项', async () => {
    const service = new ProjectService({ client: {} } as never);
    const tx = {
      financeDictItem: {
        findMany: vi.fn().mockResolvedValue([
          { id: 7, name: '华东', dictType: 'REGION', semantic: null, status: 'ACTIVE' },
        ]),
      },
    };
    const resolveDictSnapshots = (service as unknown as {
      resolveDictSnapshots: (transaction: unknown, dto: unknown) => Promise<unknown>;
    }).resolveDictSnapshots;

    await expect(
      resolveDictSnapshots.call(service, tx, { completenessDocs: [{ id: 7, name: '华东' }] }),
    ).rejects.toBeInstanceOf(BusinessException);
  });
});
