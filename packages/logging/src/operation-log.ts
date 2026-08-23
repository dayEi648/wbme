/** 操作性质（与各 schema operation_logs.action_type 枚举对齐） */
export type OperationActionType = 'CREATE' | 'UPDATE' | 'DELETE' | 'EXPORT' | 'QUERY';

/** 操作日志摘要模板输入（主 PRD §3.3） */
export interface OperationSummaryInput {
  /** 操作人姓名快照 */
  operatorName: string;
  /** 所属系统名称（展示用，如「资产系统」） */
  system: string;
  /** 功能名称（展示用，如「固定资产维护」） */
  feature: string;
  /** 操作性质 */
  actionType: OperationActionType;
  /** 操作详情片段（如「固定资产 XXX」） */
  detail: string;
}

const ACTION_VERB: Readonly<Record<OperationActionType, string>> = {
  CREATE: '新增了',
  UPDATE: '修改了',
  DELETE: '删除了',
  EXPORT: '导出了',
  QUERY: '查询了',
};

/**
 * 按统一模板生成操作内容摘要（主 PRD §3.3）。
 *
 * 示例：「张三在资产系统的固定资产维护中新增了固定资产 XXX」
 *
 * @param input 操作人、系统、功能、操作性质与详情
 * @returns 操作内容摘要
 */
export function formatOperationSummary(input: OperationSummaryInput): string {
  const verb = ACTION_VERB[input.actionType];
  return `${input.operatorName}在${input.system}的${input.feature}中${verb}${input.detail}`;
}
