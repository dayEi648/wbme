import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BusinessException } from '@wbme/contracts';
import { buildStockFlowListQuery } from './stock-flow.service';

const basePage = { page: 1, pageSize: 20 } as const;

/**
 * 库存流水列表 SQL 构建回归：
 * - 具名 inventoryItemId / consumableId / warehouseId / flowType / refType / refId 参数化；
 * - consumableId / warehouseId 经 JOIN inventory_items 后可直接筛选；
 * - 结构化筛选与排序可正常工作；
 * - flowType 等同名字段让位。
 */
describe('buildStockFlowListQuery', () => {
  it('无参数时仅返回恒真条件与默认排序', () => {
    const { whereSql, orderBySql, params } = buildStockFlowListQuery({ ...basePage });
    expect(whereSql).toBe('TRUE');
    expect(orderBySql).toBe('ORDER BY sf.created_at DESC, sf.id DESC');
    expect(params).toEqual([]);
  });

  it('具名参数生成对应条件，consumableId/warehouseId 使用 JOIN 列', () => {
    const { whereSql, params } = buildStockFlowListQuery({
      ...basePage,
      inventoryItemId: 1,
      consumableId: 2,
      warehouseId: 3,
      flowType: 'ISSUE',
      refType: 'consumable-request',
      refId: 99,
    });
    expect(whereSql).toContain('sf.inventory_item_id = $1');
    expect(whereSql).toContain('ii.consumable_id = $2');
    expect(whereSql).toContain('ii.warehouse_id = $3');
    expect(whereSql).toContain('sf.flow_type = $4');
    expect(whereSql).toContain('sf.ref_type = $5');
    expect(whereSql).toContain('sf.ref_id = $6');
    expect(params).toEqual([1, 2, 3, 'ISSUE', 'consumable-request', 99]);
  });

  it('结构化 filters 支持 flowType / consumableId / warehouseId', () => {
    const filters = JSON.stringify({
      logic: 'AND',
      conditions: [
        { field: 'flowType', operator: 'EQUALS', value: 'RETURN' },
        { field: 'consumableId', operator: 'EQUALS', value: '5' },
        { field: 'warehouseId', operator: 'EQUALS', value: '8' },
      ],
    });
    const { whereSql, params } = buildStockFlowListQuery({ ...basePage, filters });
    expect(whereSql).toContain('sf.flow_type::text = $1');
    expect(whereSql).toContain('ii.consumable_id = $2');
    expect(whereSql).toContain('ii.warehouse_id = $3');
    expect(params).toEqual(['RETURN', 5, 8]);
  });

  it('结构化 sorts 生成 ORDER BY 子句', () => {
    const sorts = JSON.stringify([{ field: 'qty', direction: 'DESC' }]);
    const { orderBySql } = buildStockFlowListQuery({ ...basePage, sorts });
    expect(orderBySql).toContain('sf.qty DESC');
  });

  it('filters 与具名参数按字段让位：flowType 在树中时具名 flowType 被跳过', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'flowType', operator: 'EQUALS', value: 'RETURN' }] });
    const { whereSql, params } = buildStockFlowListQuery({ ...basePage, flowType: 'ISSUE', filters });
    expect(params).toEqual(['RETURN']);
    expect(whereSql).toContain("sf.flow_type::text = $1");
    expect(whereSql).not.toContain("sf.flow_type::text = $1 AND sf.flow_type::text = $2");
  });

  it('filters 中未知字段抛出校验错误', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'unknown', operator: 'EQUALS', value: 'x' }] });
    expect(() => buildStockFlowListQuery({ ...basePage, filters })).toThrow(BusinessException);
  });

  it('filters 中枚举字段不支持的操作符抛出校验错误', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'flowType', operator: 'CONTAINS', value: 'ISSUE' }] });
    expect(() => buildStockFlowListQuery({ ...basePage, filters })).toThrow(BusinessException);
  });
});
