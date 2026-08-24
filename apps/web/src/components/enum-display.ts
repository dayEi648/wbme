/**
 * 面向用户展示的枚举中文文案。
 *
 * 枚举编码是接口与存储契约，不能直接作为中文界面的文案；同一编码在不同业务域可能
 * 表示不同含义（例如 ACTIVE），因此必须按枚举领域映射，不能按裸编码全局替换。
 */
export const ENUM_LABELS = {
  operationAction: {
    CREATE: '新增',
    UPDATE: '更新',
    DELETE: '删除',
    EXPORT: '导出',
    QUERY: '查询',
  },
  systemCode: {
    BASE: '基础平台',
    BACKSTAGE: '管理后台',
    ASSET: '资产系统',
    HR: '人事系统',
    FIN: '财务系统',
  },
  gender: {
    MALE: '男',
    FEMALE: '女',
  },
  productStatus: {
    OPEN: '开放',
    COMING_SOON: '即将上线',
  },
  userStatus: {
    PENDING_ACTIVATION: '待激活',
    ACTIVE: '正常',
    DEACTIVATED: '已注销',
  },
  dictionaryStatus: {
    ACTIVE: '启用',
    DISABLED: '停用',
  },
  approvalStatus: {
    DRAFT: '草稿',
    PENDING: '待审批',
    APPROVED: '已批准',
    REJECTED: '已驳回',
    CANCELLED: '已取消',
  },
  approvalAction: {
    SUBMIT: '提交',
    APPROVE: '批准',
    REJECT: '驳回',
    CANCEL: '取消',
    AUTO_CANCEL: '超时自动取消',
  },
  cancelSource: {
    USER: '申请人/代交人取消',
    ACCOUNT_DEACTIVATED: '账号注销自动取消',
    OVERDUE: '超时自动取消',
  },
  profileRequestType: {
    PROFILE_CHANGE: '资料修改',
  },
  assetStatus: {
    IDLE: '闲置',
    IN_USE: '使用中',
    PENDING_REPAIR: '待维修',
    REPAIRING: '维修中',
    SCRAPPED: '已报废',
  },
  repairStatus: {
    PENDING: '待维修',
    REPAIRING: '维修中',
    CANCELLED: '已取消',
    COMPLETED: '已完成',
  },
  lowStockStatus: {
    PENDING: '低库存',
    NORMAL: '库存正常',
  },
  borrowType: {
    PERSONAL: '个人借还',
    AGENT: '代领借还',
  },
  disposalType: {
    RETURN: '归还',
    WRITE_OFF: '核销',
    AGENT_SETTLE: '代领整单结清',
  },
  writeOffType: {
    LOST: '遗失',
    DAMAGED: '损坏',
  },
  settleMethod: {
    RETURN: '归还',
    WRITE_OFF: '核销',
  },
  stockFlowType: {
    STOCK_IN: '入库',
    ISSUE: '领用',
    DEDUCTION: '扣减',
    RETURN: '归还',
    TRANSFER_OUT: '调出',
    TRANSFER_IN: '调入',
    CORRECTION: '纠正',
  },
  qrTargetType: {
    ASSET: '固定资产',
    INVENTORY_ITEM: '库存条目',
    SCAN_CATALOG: '长期申领目录',
  },
  qrStatus: {
    ACTIVE: '有效',
    DISABLED: '已停用',
    REVOKED: '已作废',
  },
  securityEventType: {
    LOGIN_SUCCESS: '登录成功',
    LOGIN_FAILURE: '登录失败',
    LOGOUT: '退出登录',
    ACCOUNT_LOCK: '账号锁定',
    ACCOUNT_UNLOCK: '账号解锁',
    IP_LOCK: 'IP 锁定',
    IP_UNLOCK: 'IP 解锁',
    ACCOUNT_ACTIVATED: '账号激活',
    INVITATION_ISSUED: '签发邀请',
    INVITATION_USED: '使用邀请',
    PASSWORD_CHANGED: '修改密码',
    PASSWORD_RESET_ISSUED: '签发密码重置',
    PASSWORD_RESET_COMPLETED: '完成密码重置',
    DINGTALK_BOUND: '绑定钉钉',
    PHONE_SYNCED: '同步手机号',
    PHONE_SYNC_CONFLICT: '手机号冲突',
    INTERNAL_TOKEN_FAILED: '内部令牌失败',
  },
  securityResult: {
    SUCCESS: '成功',
    FAILURE: '失败',
  },
  logLevel: {
    INFO: '信息',
    WARN: '警告',
    ERROR: '错误',
    CRITICAL: '严重',
  },
  errorStatus: {
    PENDING: '待处理',
    HANDLED: '已处理',
    IGNORED: '已忽略',
  },
  announcementStatus: {
    DRAFT: '草稿',
    PUBLISHING: '展示中',
    REVOKED: '已撤回',
  },
  backupType: {
    SCHEDULED: '定时备份',
    IMMEDIATE: '立即备份',
    EMERGENCY: '紧急备份',
  },
  backupStatus: {
    RUNNING: '进行中',
    SUCCEEDED: '已完成',
    FAILED: '失败',
  },
  restoreStatus: {
    PENDING: '待执行',
    PRECHECK: '预检中',
    MAINTENANCE: '维护中',
    RESTORING: '恢复中',
    SUCCEEDED: '已完成',
    FAILED: '失败',
  },
  restoreBlockedReason: {
    TARGET_NOT_FOUND: '目标账号不存在',
    TARGET_NOT_DEACTIVATED: '目标账号未处于已注销状态',
    SUPER_ADMIN_TARGET: '超级管理员账号仅可由超级管理员管理',
    PHONE_OCCUPIED: '手机号已被其他待激活/正常账号占用',
    VERSION_CONFLICT: '账号状态已变化，请重新预览',
  },
  diskStatus: {
    OK: '正常',
    WARN: '预警',
    CRITICAL: '严重',
  },
  backgroundTaskType: {
    ACCOUNT_LIFECYCLE: '账号生命周期处理',
    SCHEDULED_BACKUP: '定时数据备份',
    IMMEDIATE_BACKUP: '立即数据备份',
    RESTORE_DELIVERY: '数据恢复交付',
    EMERGENCY_BACKUP: '紧急数据备份',
    UNASSOCIATED_IMAGE_CLEANUP: '未关联图片清理',
    APPROVAL_TIMEOUT_SCAN: '审批超时检查',
    LOG_RETENTION_CLEANUP: '日志保留期清理',
  },
  backgroundTaskModule: {
    backstage: '管理后台',
    asset: '资产系统',
    hr: '人事系统',
    fin: '财务系统',
  },
  dataScope: {
    SELF: '仅本人',
    DEPARTMENT: '本部门',
    COMPANY: '全公司',
  },
  assetRequestType: {
    STOCK_IN: '入库申请',
    STOCK_CHANGE: '库存变更',
    CONSUMABLE_REQUEST: '消耗品申领',
    AGENT_REQUEST: '代领申请',
    RETURN: '归还申请',
    WRITE_OFF: '核销申请',
    AGENT_SETTLEMENT: '代领结清',
  },
  hrRequestType: {
    OVERTIME: '加班申请',
    POSITION_CHANGE: '岗位变更',
  },
  holidayDateType: {
    WORKDAY: '工作日',
    WEEKEND: '周末',
    HOLIDAY: '法定节假日',
    ADJUSTED_HOLIDAY: '调休假日',
    ADJUSTED_WORKDAY: '调休工作日',
  },
  financeProjectAction: {
    CREATE: '新建',
    EDIT: '编辑',
    DELETE: '删除',
    IMPORT_CREATE: '导入新增',
    IMPORT_OVERWRITE: '导入覆盖',
    IMPORT_SKIP: '导入跳过',
  },
  financeDictType: {
    PROGRESS: '项目进度',
    COMPLETENESS: '资料齐全度',
    BIZ_CATEGORY: '业务分类',
    REGION: '地区',
  },
  amountSemantic: {
    TENTATIVE: '暂定',
    AUDITED: '审定',
  },
  siteRole: {
    SUPER_ADMIN: '超级管理员',
    EMPLOYEE: '员工',
  },
  assetOwnership: {
    COMPANY: '公司',
    PARTNER: '合作方',
  },
  consumableType: {
    DISPOSABLE: '一次性用品',
    REUSABLE: '借还用品',
  },
  quotaCycle: {
    MONTH: '月',
    QUARTER: '季度',
    YEAR: '年',
  },
  assetDictType: {
    UNIT: '单位',
    CHANGE_TYPE: '变更类型',
    SUPPLIER: '供应商',
    BRAND: '品牌',
    SPEC: '规格',
    ASSET_SPEC: '资产规格',
    ASSET_MODEL: '资产型号',
  },
  hrDictType: {
    PLACEHOLDER: '占位类型',
  },
} as const satisfies Record<string, Readonly<Record<string, string>>>;

export type EnumKind = keyof typeof ENUM_LABELS;

/** 枚举值只在其所属领域中翻译；未知编码不直接暴露给业务用户。 */
export function formatEnumLabel(kind: EnumKind, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const labels: Readonly<Record<string, string>> = ENUM_LABELS[kind];
  return labels[String(value)] ?? '未知';
}

/** 供 Select / 高级筛选复用，提交值始终保持接口所需的英文编码。 */
export function enumOptions(kind: EnumKind): Array<{ label: string; value: string }> {
  return Object.entries(ENUM_LABELS[kind]).map(([value, label]) => ({ label, value }));
}

/** 根据枚举语义返回 Ant Design Tag 的语义色，而不是从中文文案推断。 */
export function enumTagColor(kind: EnumKind, value: unknown): 'green' | 'orange' | 'red' | 'blue' | 'default' {
  const code = String(value ?? '');
  if (['APPROVED', 'ACTIVE', 'COMPLETED', 'SUCCEEDED', 'SUCCESS', 'OPEN', 'NORMAL', 'IDLE', 'IN_USE', 'RETURN', 'STOCK_IN', 'TRANSFER_IN'].includes(code)) return 'green';
  if (['PENDING', 'PENDING_REPAIR', 'REPAIRING', 'RUNNING', 'PRECHECK', 'MAINTENANCE', 'RESTORING', 'QUEUED', 'DRAFT', 'PUBLISHING', 'WARN', 'ISSUE', 'DEDUCTION', 'TRANSFER_OUT', 'CORRECTION'].includes(code)) return 'orange';
  if (['REJECTED', 'DEACTIVATED', 'DISABLED', 'SCRAPPED', 'FAILED', 'FAILURE', 'REVOKED', 'CANCELLED', 'CRITICAL'].includes(code)) return 'red';
  if (kind === 'securityEventType' || kind === 'operationAction' || kind === 'financeProjectAction') return 'blue';
  return 'default';
}
