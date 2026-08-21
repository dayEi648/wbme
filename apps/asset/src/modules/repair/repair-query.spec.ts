import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { buildRepairListWhere } from './repair.service';

const basePage = { page: 1, pageSize: 20 } as const;

/**
 * 维修单列表 where 构建回归：
 * - 具名 assetId / status 正确写入 where；
 * - DEPARTMENT 档加入资产部门闭包裁剪；
 * - 结构化 filters 与具名参数按字段让位；
 * - 无 filters 时保持向后兼容。
 */
describe('buildRepairListWhere', () => {
  it('无参数且公司档时返回空对象', () => {
    expect(buildRepairListWhere({ ...basePage }, 'COMPANY')).toEqual({});
  });

  it('具名 assetId / status 写入 where', () => {
    const where = buildRepairListWhere({ ...basePage, assetId: 5, status: 'PENDING' }, 'COMPANY');
    expect(where).toEqual({ assetId: 5, status: 'PENDING' });
  });

  it('DEPARTMENT 档写入资产部门闭包裁剪', () => {
    const where = buildRepairListWhere({ ...basePage }, 'DEPARTMENT', new Set([10, 11]));
    expect(where).toEqual({ asset: { departmentId: { in: [10, 11] } } });
  });

  it('DEPARTMENT 档与具名参数同时存在时以 AND 语义合并', () => {
    const where = buildRepairListWhere({ ...basePage, status: 'REPAIRING' }, 'DEPARTMENT', new Set([10]));
    expect(where).toEqual({
      asset: { departmentId: { in: [10] } },
      status: 'REPAIRING',
    });
  });

  it('filters 与具名参数按字段让位：status 在树中时具名 status 被跳过', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'status', operator: 'EQUALS', value: 'COMPLETED' }] });
    const where = buildRepairListWhere({ ...basePage, status: 'PENDING', filters }, 'COMPANY');
    expect(where.status).toBeUndefined();
    expect(where.assetId).toBeUndefined();
  });

  it('filters 与具名参数按字段让位：assetId 在树中时具名 assetId 被跳过', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'assetId', operator: 'EQUALS', value: '99' }] });
    const where = buildRepairListWhere({ ...basePage, assetId: 5, filters }, 'COMPANY');
    expect(where.assetId).toBeUndefined();
  });

});
