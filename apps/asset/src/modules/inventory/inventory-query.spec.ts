import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BusinessException } from '@wbme/contracts';
import { buildBatchListQuery, buildInventoryItemComputedListQuery } from './inventory.service';

const basePage = { page: 1, pageSize: 20 } as const;

/**
 * 库存条目（低库存/可用库存路径）SQL 构建回归：
 * - 具名参数与结构化 filters 以 AND 合并；
 * - 同名字段让位；
 * - 无 filters 时保持原有行为。
 */
describe('buildInventoryItemComputedListQuery', () => {
  it('无参数时仅返回恒真条件与默认排序', () => {
    const { whereSql, orderBySql, params } = buildInventoryItemComputedListQuery({ ...basePage });
    expect(whereSql).toBe('TRUE');
    expect(orderBySql).toBe('ORDER BY ii.id ASC');
    expect(params).toEqual([]);
  });

  it('具名 consumableId / warehouseId / spec 生成参数化条件', () => {
    const { whereSql, params } = buildInventoryItemComputedListQuery({
      ...basePage,
      consumableId: 11,
      warehouseId: 22,
      spec: '标准',
    });
    expect(whereSql).toContain('ii.consumable_id = $1');
    expect(whereSql).toContain('ii.warehouse_id = $2');
    expect(whereSql).toContain('ii.spec = $3');
    expect(params).toEqual([11, 22, '标准']);
  });

  it('低库存/可用库存标志加入固定计算条件', () => {
    const low = buildInventoryItemComputedListQuery({ ...basePage, lowStockOnly: true });
    expect(low.whereSql).toContain('ii.book_qty - ii.reserved_qty < c.safety_stock');

    const avail = buildInventoryItemComputedListQuery({ ...basePage, availableOnly: true });
    expect(avail.whereSql).toContain("c.status = 'ACTIVE'");
    expect(avail.whereSql).toContain('ii.book_qty > ii.reserved_qty');
  });

  it('结构化 filters 与具名参数以 AND 合并', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'bookQty', operator: 'GREATER_THAN', value: '10' }] });
    const { whereSql, params } = buildInventoryItemComputedListQuery({ ...basePage, consumableId: 5, filters });
    expect(whereSql).toContain('ii.consumable_id = $1');
    expect(whereSql).toContain('ii.book_qty > $2');
    expect(params).toEqual([5, 10]);
  });

  it('结构化 sorts 生成 ORDER BY 子句', () => {
    const sorts = JSON.stringify([{ field: 'warehouseId', direction: 'DESC' }]);
    const { orderBySql } = buildInventoryItemComputedListQuery({ ...basePage, sorts });
    expect(orderBySql).toContain('ii.warehouse_id DESC');
  });

  it('filters 与具名参数按字段让位：consumableId 在树中时具名 consumableId 被跳过', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'consumableId', operator: 'EQUALS', value: '99' }] });
    const { whereSql, params } = buildInventoryItemComputedListQuery({ ...basePage, consumableId: 5, filters });
    expect(params).toEqual([99]);
    expect(whereSql).not.toContain('ii.consumable_id = $1 AND');
    expect(whereSql).toContain('ii.consumable_id = $1');
  });

  it('filters 中未知字段抛出校验错误', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'unknownField', operator: 'EQUALS', value: 'x' }] });
    expect(() => buildInventoryItemComputedListQuery({ ...basePage, filters })).toThrow(BusinessException);
  });

  it('filters 中字段不支持的操作符抛出校验错误', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'spec', operator: 'GREATER_THAN', value: 'x' }] });
    expect(() => buildInventoryItemComputedListQuery({ ...basePage, filters })).toThrow(BusinessException);
  });
});

/**
 * 批次列表 SQL 构建回归：
 * - 具名 inventoryItemId / consumableId / warehouseId 参数化；
 * - warehouseId 经 JOIN inventory_items 后可直接筛选；
 * - 结构化筛选与排序可正常工作；
 * - 同名字段让位。
 */
describe('buildBatchListQuery', () => {
  it('无参数时仅返回恒真条件与默认排序', () => {
    const { whereSql, orderBySql, params } = buildBatchListQuery({ ...basePage });
    expect(whereSql).toBe('TRUE');
    expect(orderBySql).toBe('ORDER BY b.received_at DESC, b.id DESC');
    expect(params).toEqual([]);
  });

  it('具名参数生成对应条件，warehouseId 使用 JOIN 后的 ii.warehouse_id', () => {
    const { whereSql, params } = buildBatchListQuery({
      ...basePage,
      inventoryItemId: 1,
      consumableId: 2,
      warehouseId: 3,
    });
    expect(whereSql).toContain('b.inventory_item_id = $1');
    expect(whereSql).toContain('b.consumable_id = $2');
    expect(whereSql).toContain('ii.warehouse_id = $3');
    expect(params).toEqual([1, 2, 3]);
  });

  it('结构化 filters 支持 warehouseId 与 consumableName', () => {
    const filters = JSON.stringify({
      logic: 'AND',
      conditions: [
        { field: 'warehouseId', operator: 'EQUALS', value: '7' },
        { field: 'consumableName', operator: 'CONTAINS', value: '纸' },
      ],
    });
    const { whereSql, params } = buildBatchListQuery({ ...basePage, filters });
    expect(whereSql).toContain('ii.warehouse_id = $1');
    expect(whereSql).toContain("b.consumable_name ILIKE '%' || $2 || '%'");
    expect(params).toEqual([7, '纸']);
  });

  it('结构化 sorts 生成 ORDER BY 子句', () => {
    const sorts = JSON.stringify([{ field: 'remainingQty', direction: 'ASC' }]);
    const { orderBySql } = buildBatchListQuery({ ...basePage, sorts });
    expect(orderBySql).toContain('b.remaining_qty ASC');
  });

  it('filters 与具名参数按字段让位：warehouseId 在树中时具名 warehouseId 被跳过', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'warehouseId', operator: 'EQUALS', value: '9' }] });
    const { whereSql, params } = buildBatchListQuery({ ...basePage, warehouseId: 3, filters });
    expect(params).toEqual([9]);
    expect(whereSql).toContain('ii.warehouse_id = $1');
    expect(whereSql).not.toContain('ii.warehouse_id = $1 AND ii.warehouse_id = $2');
  });

  it('filters 中未知字段抛出校验错误', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'unknown', operator: 'EQUALS', value: 'x' }] });
    expect(() => buildBatchListQuery({ ...basePage, filters })).toThrow(BusinessException);
  });
});
