import type { ApprovalAction, ApprovalStatus, CancelSource, DataScope } from '@wbme/contracts';

/**
 * 审批处理意图（主 PRD §3.2）。
 * - APPROVE / REJECT：合格审批人处理
 * - CANCEL：提交人或代交人主动取消（cancelSource=USER）
 * - AUTO_CANCEL：超时或账号注销等系统取消（须携带 cancelSource）
 */
export type ProcessAction = 'APPROVE' | 'REJECT' | 'CANCEL' | 'AUTO_CANCEL';

/** 解析后的目标状态与动作流水字段 */
export interface ResolvedTransition {
  /** 目标审批状态 */
  status: ApprovalStatus;
  /** 写入 approval_actions 的动作 */
  action: ApprovalAction;
  /** 取消来源（仅 CANCELLED 终态） */
  cancelSource: CancelSource | null;
  /** 驳回是否强制要求意见 */
  requiresOpinion: boolean;
}

/** 审批头最小字段（内核读写所需） */
export interface ApprovalHead {
  id: number;
  status: ApprovalStatus;
  version: number;
  requestType: string;
  applicantId: number;
  proxyId: number | null;
  applicantDepartmentSnapshot: unknown;
}

/** 申请对象部门快照（列表/范围校验用） */
export interface ApplicationObjectScope {
  /** 提交时部门 id；无部门时为 null */
  departmentId: number | null;
}

/**
 * 审批人数据范围（主 PRD §3.2）。
 * - COMPANY：可见全部
 * - DEPARTMENT：须覆盖批次全部对象的部门快照（含下级闭包由调用方展开进 departmentIds）
 * - null：超管豁免，等同 COMPANY
 */
export type ApproverScope =
  | { kind: 'COMPANY' }
  | { kind: 'DEPARTMENT'; departmentIds: ReadonlySet<number> };

/** 资产系统仅公司范围可处理的申请类型（主 PRD §3.2 明确例外） */
export const ASSET_COMPANY_ONLY_REQUEST_TYPES = ['STOCK_IN', 'STOCK_CHANGE'] as const;

/** 超时扫描覆盖的 schema（各模块自有审批头） */
export const APPROVAL_SCHEMAS = ['backstage', 'hr', 'asset'] as const;

export type ApprovalSchema = (typeof APPROVAL_SCHEMAS)[number];

/** 与 DataScope 对齐的范围推导辅助类型 */
export type { DataScope, ApprovalStatus, ApprovalAction, CancelSource };
