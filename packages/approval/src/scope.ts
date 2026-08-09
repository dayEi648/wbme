import { BusinessException, approvalErrors, type DataScope } from '@wbme/contracts';
import {
  ASSET_COMPANY_ONLY_REQUEST_TYPES,
  type ApplicationObjectScope,
  type ApproverScope,
} from './types';

/**
 * 将授权数据范围档位转为审批人范围（超管 dataScope=null → COMPANY）。
 *
 * @param dataScope 守卫写入的数据范围；null 表示超管豁免
 * @param departmentIds 部门档时调用方展开的部门闭包（含本级与下级）
 * @returns 审批人范围
 */
export function toApproverScope(
  dataScope: DataScope | null,
  departmentIds: ReadonlySet<number> = new Set(),
): ApproverScope {
  if (dataScope === null || dataScope === 'COMPANY') {
    return { kind: 'COMPANY' };
  }
  return { kind: 'DEPARTMENT', departmentIds };
}

/**
 * 判断申请类型是否要求公司范围（资产入库/库存变更例外）。
 *
 * @param requestType 申请类型
 * @returns 是否仅公司范围
 */
export function isCompanyOnlyRequestType(requestType: string): boolean {
  return (ASSET_COMPANY_ONLY_REQUEST_TYPES as readonly string[]).includes(requestType);
}

/**
 * 批次对象部门 id 列表：无独立对象时回退申请人部门快照。
 *
 * @param objects 申请对象列表（可空）
 * @param applicantDepartmentId 申请人提交时部门 id
 * @returns 用于范围校验的部门 id 列表（至少一项，可为 null）
 */
export function resolveObjectDepartmentIds(
  objects: readonly ApplicationObjectScope[] | undefined,
  applicantDepartmentId: number | null,
): readonly (number | null)[] {
  if (objects !== undefined && objects.length > 0) {
    return objects.map((item) => item.departmentId);
  }
  return [applicantDepartmentId];
}

/**
 * 判断审批人数据范围是否覆盖批次全部申请对象（主 PRD §3.2）。
 *
 * @param scope 审批人范围
 * @param objectDepartmentIds 对象部门 id（null = 无部门，仅公司范围可覆盖）
 * @param requestType 申请类型（用于资产公司范围例外）
 * @returns 是否可见/可处理
 */
export function scopeCoversAll(
  scope: ApproverScope,
  objectDepartmentIds: readonly (number | null)[],
  requestType?: string,
): boolean {
  if (requestType !== undefined && isCompanyOnlyRequestType(requestType) && scope.kind !== 'COMPANY') {
    return false;
  }
  if (scope.kind === 'COMPANY') {
    return true;
  }
  if (objectDepartmentIds.length === 0) {
    return false;
  }
  for (const departmentId of objectDepartmentIds) {
    if (departmentId === null || !scope.departmentIds.has(departmentId)) {
      return false;
    }
  }
  return true;
}

/**
 * 范围未覆盖时抛出 SCOPE_NOT_COVERED（处理接口）；列表/详情应改用 404。
 *
 * @param scope 审批人范围
 * @param objectDepartmentIds 对象部门 id
 * @param requestType 申请类型
 * @throws SCOPE_NOT_COVERED
 */
export function assertScopeCoversAll(
  scope: ApproverScope,
  objectDepartmentIds: readonly (number | null)[],
  requestType?: string,
): void {
  if (!scopeCoversAll(scope, objectDepartmentIds, requestType)) {
    throw new BusinessException(approvalErrors.SCOPE_NOT_COVERED, { requestType });
  }
}

/**
 * 从部门快照 JSON 提取部门 id（兼容 `{ id }` / `{ departmentId }` / number）。
 *
 * @param snapshot 快照 JSON（单元素）
 * @returns 部门 id 或 null
 */
export function extractDepartmentIdFromSnapshot(snapshot: unknown): number | null {
  if (typeof snapshot === 'number' && Number.isFinite(snapshot)) {
    return snapshot;
  }
  if (typeof snapshot === 'object' && snapshot !== null) {
    const record = snapshot as Record<string, unknown>;
    const id = record.id ?? record.departmentId;
    if (typeof id === 'number' && Number.isFinite(id)) {
      return id;
    }
  }
  return null;
}

/**
 * 从部门快照 JSON 提取全部部门 id（兼容数组/单元素；多部门员工快照为数组）。
 *
 * @param snapshot 快照 JSON（数组或单元素）
 * @returns 部门 id 列表（逐元素提取，无法解析的元素为 null）
 */
export function extractDepartmentIdsFromSnapshot(snapshot: unknown): Array<number | null> {
  const list = Array.isArray(snapshot) ? snapshot : [snapshot];
  return list.map((entry) => extractDepartmentIdFromSnapshot(entry));
}
