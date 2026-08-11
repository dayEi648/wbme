import { BusinessException } from '@wbme/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../generated/prisma/client';
import { ProjectService, diffProject, mergeProjectUpdateDto, type DictSnapshots } from './project.service';

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

describe('mergeProjectUpdateDto 资料齐全度（PATCH 语义，与分包方同口径）', () => {
  const baseDto = { name: '测试项目', year: 2026 };
  const existingDocs = [{ id: 5, name: '总包合同' }];

  it('未提交资料齐全度时保留库中旧值（不静默清空）', () => {
    expect(mergeProjectUpdateDto(baseDto, [], existingDocs).completenessDocs).toEqual(existingDocs);
  });

  it('显式空数组保留清空意图', () => {
    expect(mergeProjectUpdateDto({ ...baseDto, completenessDocs: [] }, [], existingDocs).completenessDocs).toEqual([]);
  });

  it('显式数组替换旧值', () => {
    const nextDocs = [{ id: 6, name: '分包合同' }];
    expect(mergeProjectUpdateDto({ ...baseDto, completenessDocs: nextDocs }, [], existingDocs).completenessDocs).toEqual(nextDocs);
  });

  it('库中为 null 时未提交按未设置处理', () => {
    expect(mergeProjectUpdateDto(baseDto, [], null).completenessDocs).toBeUndefined();
  });
});

describe('diffProject 空值归一（幻影差异防回归）', () => {
  const emptySnapshots: DictSnapshots = {
    regionName: null,
    progressName: null,
    progressSemantic: null,
    bizCategoryName: null,
    completenessDocs: [],
  };
  const baseDto = { name: '测试项目', year: 2026 };

  /** 构造仅含 diff 所需字段的项目行（未列字段按 null 参与比较） */
  const fakeProject = (overrides: Record<string, unknown>): Project =>
    ({ id: 1, name: '测试项目', year: 2026, ...overrides }) as unknown as Project;

  it('库中 completenessDocs 为 [] 且提交未变更 → 无差异（不再写假变更记录）', () => {
    const diff = diffProject(fakeProject({ completenessDocs: [], subcontractors: [] }), { ...baseDto, completenessDocs: [] }, '测试项目', emptySnapshots);
    expect(diff.changed.size).toBe(0);
  });

  it('库中 completenessDocs 为 null、提交侧归一为 [] → 空值等价无差异', () => {
    const diff = diffProject(fakeProject({ completenessDocs: null, subcontractors: [] }), { ...baseDto, completenessDocs: [] }, '测试项目', emptySnapshots);
    expect(diff.changed.size).toBe(0);
  });

  it('库中快照与解析结果一致 → 无差异；真实替换 → 记录前后值', () => {
    const docs = [{ id: 5, name: '总包合同' }];
    const unchanged = diffProject(
      fakeProject({ completenessDocs: docs, subcontractors: [] }),
      { ...baseDto, completenessDocs: docs },
      '测试项目',
      { ...emptySnapshots, completenessDocs: docs },
    );
    expect(unchanged.changed.size).toBe(0);

    const nextDocs = [{ id: 6, name: '分包合同' }];
    const changed = diffProject(
      fakeProject({ completenessDocs: docs, subcontractors: [] }),
      { ...baseDto, completenessDocs: nextDocs },
      '测试项目',
      { ...emptySnapshots, completenessDocs: nextDocs },
    );
    expect(changed.changed.has('completenessDocs')).toBe(true);
    expect(changed.before.completenessDocs).toEqual(docs);
    expect(changed.after.completenessDocs).toEqual(nextDocs);
  });
});
