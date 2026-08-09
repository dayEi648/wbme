import { describe, expect, it } from 'vitest';
import { BusinessException, approvalErrors } from '@wbme/contracts';
import {
  assertScopeCoversAll,
  extractDepartmentIdFromSnapshot,
  extractDepartmentIdsFromSnapshot,
  isCompanyOnlyRequestType,
  resolveObjectDepartmentIds,
  scopeCoversAll,
  toApproverScope,
} from './scope';

describe('toApproverScope / isCompanyOnlyRequestType', () => {
  it('null/COMPANY → COMPANY；DEPARTMENT 携带闭包', () => {
    expect(toApproverScope(null)).toEqual({ kind: 'COMPANY' });
    expect(toApproverScope('COMPANY')).toEqual({ kind: 'COMPANY' });
    const dept = toApproverScope('DEPARTMENT', new Set([1, 2]));
    expect(dept).toEqual({ kind: 'DEPARTMENT', departmentIds: new Set([1, 2]) });
  });

  it('STOCK_IN/STOCK_CHANGE 仅公司范围', () => {
    expect(isCompanyOnlyRequestType('STOCK_IN')).toBe(true);
    expect(isCompanyOnlyRequestType('STOCK_CHANGE')).toBe(true);
    expect(isCompanyOnlyRequestType('RETURN')).toBe(false);
  });
});

describe('scopeCoversAll', () => {
  const company = toApproverScope('COMPANY');
  const dept = toApproverScope('DEPARTMENT', new Set([10, 11]));

  it('公司范围覆盖全部', () => {
    expect(scopeCoversAll(company, [10, 99])).toBe(true);
    expect(scopeCoversAll(company, [null], 'STOCK_IN')).toBe(true);
  });

  it('部门范围须覆盖全部对象；无部门对象不可见', () => {
    expect(scopeCoversAll(dept, [10, 11])).toBe(true);
    expect(scopeCoversAll(dept, [10, 12])).toBe(false);
    expect(scopeCoversAll(dept, [null])).toBe(false);
  });

  it('部门范围不可见 STOCK_IN/STOCK_CHANGE', () => {
    expect(scopeCoversAll(dept, [10], 'STOCK_IN')).toBe(false);
    expect(scopeCoversAll(dept, [10], 'RETURN')).toBe(true);
  });

  it('assertScopeCoversAll 抛 SCOPE_NOT_COVERED', () => {
    try {
      assertScopeCoversAll(dept, [99]);
      expect.fail('应抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessException);
      expect((error as BusinessException).entry.code).toBe(approvalErrors.SCOPE_NOT_COVERED.code);
    }
  });
});

describe('resolveObjectDepartmentIds / extractDepartmentIdFromSnapshot', () => {
  it('无对象时回退申请人部门', () => {
    expect(resolveObjectDepartmentIds(undefined, 5)).toEqual([5]);
    expect(resolveObjectDepartmentIds([], 5)).toEqual([5]);
    expect(resolveObjectDepartmentIds([{ departmentId: 1 }, { departmentId: 2 }], 5)).toEqual([1, 2]);
  });

  it('解析快照 id', () => {
    expect(extractDepartmentIdFromSnapshot({ id: 7 })).toBe(7);
    expect(extractDepartmentIdFromSnapshot({ departmentId: 8 })).toBe(8);
    expect(extractDepartmentIdFromSnapshot(9)).toBe(9);
    expect(extractDepartmentIdFromSnapshot(null)).toBeNull();
  });

  it('展开数组快照（多部门员工）', () => {
    expect(extractDepartmentIdsFromSnapshot([{ id: 1 }, { id: 2 }])).toEqual([1, 2]);
    expect(extractDepartmentIdsFromSnapshot([{ id: 1 }, { departmentId: 2 }, 3])).toEqual([1, 2, 3]);
    expect(extractDepartmentIdsFromSnapshot({ id: 7 })).toEqual([7]);
    expect(extractDepartmentIdsFromSnapshot(9)).toEqual([9]);
    expect(extractDepartmentIdsFromSnapshot([{ id: 1 }, null])).toEqual([1, null]);
  });
});
