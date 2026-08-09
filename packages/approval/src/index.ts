/**
 * @wbme/approval 包入口
 * 统一审批内核：状态机、字段契约、并发控制、范围校验与超时扫描（主 PRD §3.2，T5-1）。
 */

export type {
  ProcessAction,
  ResolvedTransition,
  ApprovalHead,
  ApplicationObjectScope,
  ApproverScope,
  ApprovalSchema,
  DataScope,
  ApprovalStatus,
  ApprovalAction,
  CancelSource,
} from './types';

export { ASSET_COMPANY_ONLY_REQUEST_TYPES, APPROVAL_SCHEMAS } from './types';

export {
  TERMINAL_APPROVAL_STATUSES,
  isTerminalApprovalStatus,
  assertTransitionAllowed,
  resolveProcessTransition,
  assertOpinionIfRequired,
  throwIfTransitionLost,
  assertPending,
} from './state-machine';

export {
  toApproverScope,
  isCompanyOnlyRequestType,
  resolveObjectDepartmentIds,
  scopeCoversAll,
  assertScopeCoversAll,
  extractDepartmentIdFromSnapshot,
  extractDepartmentIdsFromSnapshot,
} from './scope';

export { isPrismaUniqueViolation, mapPendingLimitError, withPendingLimitMapping } from './pending-limit';

export {
  generateApplicationNo,
  APPLICATION_NO_PREFIX_PROFILE_CHANGE,
  APPLICATION_NO_PREFIX_OVERTIME,
  APPLICATION_NO_PREFIX_POSITION_CHANGE,
  APPLICATION_NO_PREFIX_ASSET,
} from './application-no';

export type { SqlClient } from './sql-client';

export {
  APPROVAL_TIMEOUT_BATCH_SIZE,
  overdueCutoff,
  listOverduePending,
  autoCancelOverdueRow,
  scanAndAutoCancelOverdue,
  type OverdueApprovalRow,
} from './timeout';
