import { describe, expect, it } from 'vitest';
import { BORROW_HISTORY_COLUMNS, buildScannedClaimInitialValues, DISPOSAL_PENDING_COLUMNS, DISPOSAL_RECORDS_COLUMNS } from './AssetPage';

/**
 * M20/M28 复核修复的列契约回归测试：前端列 key 必须对得上后端查询返回字段
 * （经 DataTable normalizeRow 转驼峰）。锚点字段集与后端 SQL SELECT 逐字对应：
 * - 借还历史：borrow.service.ts listHistory
 * - 待处置：disposal.service.ts listPending（snake_case 转驼峰）
 * - 处置记录：disposal.service.ts listRecords（SQL 别名已是 camelCase）
 * 未来任一侧增删字段导致漂移时此处断言失败，防止"列恒空"问题复发。
 */

const BORROW_HISTORY_FIELDS = new Set([
  'id', 'recordType', 'userId', 'userName', 'requestId', 'agentRequestId', 'inventoryItemId',
  'consumableName', 'spec', 'warehouseName', 'warehousePath', 'qty', 'borrowedAt', 'dueAt',
  'returnedQty', 'writtenOffQty', 'createdAt',
]);

const DISPOSAL_PENDING_FIELDS = new Set([
  'recordId', 'recordType', 'userId', 'userName', 'departmentSnapshot', 'requestId',
  'agentRequestId', 'consumableName', 'spec', 'warehouseName', 'warehousePath', 'qty',
  'borrowedAt', 'dueAt', 'returnedQty', 'writtenOffQty', 'userStatus',
]);

const DISPOSAL_RECORDS_FIELDS = new Set([
  'id', 'disposalType', 'borrowRecordId', 'agentRequestId', 'userId', 'userName',
  'inventoryItemId', 'consumableName', 'spec', 'warehouseName', 'warehousePath', 'qty',
  'writeOffType', 'reason', 'processorId', 'processorName', 'createdAt', 'departmentSnapshot', 'recordType',
]);

function columnKeys(columns: Array<{ key: string }>): string[] {
  return columns.map((column) => column.key);
}

describe('AssetPage 列契约（M20/M28 回归防护）', () => {
  it('借还历史列全部存在于后端 listHistory 字段集', () => {
    const keys = columnKeys(BORROW_HISTORY_COLUMNS);
    expect(keys).not.toHaveLength(0);
    for (const key of keys) {
      expect(BORROW_HISTORY_FIELDS.has(key), `列 ${key} 不在后端 listHistory 返回字段中`).toBe(true);
    }
  });

  it('待处置列全部存在于后端 listPending 字段集', () => {
    const keys = columnKeys(DISPOSAL_PENDING_COLUMNS);
    expect(keys).not.toHaveLength(0);
    for (const key of keys) {
      expect(DISPOSAL_PENDING_FIELDS.has(key), `列 ${key} 不在后端 listPending 返回字段中`).toBe(true);
    }
  });

  it('处置记录列全部存在于后端 listRecords 字段集', () => {
    const keys = columnKeys(DISPOSAL_RECORDS_COLUMNS);
    expect(keys).not.toHaveLength(0);
    for (const key of keys) {
      expect(DISPOSAL_RECORDS_FIELDS.has(key), `列 ${key} 不在后端 listRecords 返回字段中`).toBe(true);
    }
  });

  it('库存二维码将条目 ID 预填到申领明细', () => {
    expect(buildScannedClaimInitialValues('42')).toEqual({
      items: '[\n  {\n    "inventoryItemId": 42,\n    "qty": 1,\n    "purpose": ""\n  }\n]',
    });
    expect(buildScannedClaimInitialValues('invalid')).toBeUndefined();
  });
});
