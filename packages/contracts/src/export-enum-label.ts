/**
 * 导出面向业务人员时使用的枚举中文标签。
 *
 * 枚举编码是接口和数据库的稳定契约，不能直接写进下载文件；未知编码也不能回显
 * 内部值，以免新增枚举后再次把英文技术编码暴露给用户。
 */
const EXPORT_ENUM_LABELS = {
  approvalStatus: {
    DRAFT: '草稿',
    PENDING: '待审批',
    APPROVED: '已批准',
    REJECTED: '已驳回',
    CANCELLED: '已取消',
  },
  hrRequestType: {
    OVERTIME: '加班申请',
    POSITION_CHANGE: '岗位变更',
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
  profileRequestType: {
    PROFILE_CHANGE: '资料修改',
  },
  holidayDateType: {
    WORKDAY: '工作日',
    WEEKEND: '周末',
    HOLIDAY: '法定节假日',
    ADJUSTED_HOLIDAY: '调休假日',
    ADJUSTED_WORKDAY: '调休工作日',
  },
  assetStatus: {
    IDLE: '闲置',
    IN_USE: '使用中',
    PENDING_REPAIR: '待维修',
    REPAIRING: '维修中',
    SCRAPPED: '已报废',
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
  flowDirection: {
    IN: '入库',
    OUT: '出库',
  },
  stockFlowReference: {
    STOCK_IN: '入库申请',
    STOCK_CHANGE: '库存变更',
    CONSUMABLE_REQUEST: '消耗品申领',
    AGENT_REQUEST: '代领申请',
    RETURN: '归还',
    AGENT_SETTLEMENT: '代领结清',
    DIRECT_DISPOSAL: '直接处置',
    TRANSFER: '库存调拨',
    'batch-correction': '批次纠正',
  },
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
} as const satisfies Record<string, Readonly<Record<string, string>>>;

export type ExportEnumKind = keyof typeof EXPORT_ENUM_LABELS;

/** 将已知枚举转为中文；空值留空，未知编码统一显示“未知”。 */
export function formatExportEnumLabel(kind: ExportEnumKind, value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const labels: Readonly<Record<string, string>> = EXPORT_ENUM_LABELS[kind];
  return labels[String(value)] ?? '未知';
}
