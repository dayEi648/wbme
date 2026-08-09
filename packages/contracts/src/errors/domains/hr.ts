import type { ErrorEntry } from '../types';

/** HR 域错误目录：组织架构、部门岗位、加班（hr PRD） */
export const hrErrors = {
  /** 加班时间段与已有待审批/已批准记录重叠（hr PRD §3） */
  OVERTIME_OVERLAP: {
    code: 'OVERTIME_OVERLAP',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '加班时间段与已有记录重叠',
  },
  /** 加班日期超出提前申请/补交窗口（hr PRD §3） */
  OVERTIME_DATE_OUT_OF_WINDOW: {
    code: 'OVERTIME_DATE_OUT_OF_WINDOW',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '加班日期超出允许申请的时间范围',
  },
  /** 多部门员工不能通过个人中心变更组织关系（base PRD §6） */
  MULTI_DEPARTMENT_APPLY_FORBIDDEN: {
    code: 'MULTI_DEPARTMENT_APPLY_FORBIDDEN',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '已属于多个部门的员工不能通过个人中心变更组织关系',
  },
  /** 岗位必须同时适用于员工全部当前部门（hr PRD §5） */
  POSITION_DEPARTMENT_MISMATCH: {
    code: 'POSITION_DEPARTMENT_MISMATCH',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '岗位不适用于所选部门的全部归属关系',
  },
  /** 岗位变更在待审批期间条件不再成立，不可批准（hr PRD §5） */
  POSITION_APPLY_STALE: {
    code: 'POSITION_APPLY_STALE',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '申请条件已变化，当前不可批准',
  },
  /** 部门存在未删除下级部门时禁止删除（hr PRD §6） */
  DEPARTMENT_HAS_CHILDREN: {
    code: 'DEPARTMENT_HAS_CHILDREN',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '存在未删除的下级部门，请先处理',
  },
  /** 组织关系调整不能形成循环（hr PRD §6） */
  ORGANIZATION_CYCLE: {
    code: 'ORGANIZATION_CYCLE',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '组织关系不能形成循环',
  },
  /** 组织架构版本冲突（部门闭包变化使旧权限缓存失效，base PRD §3） */
  ORGANIZATION_VERSION_CONFLICT: {
    code: 'ORGANIZATION_VERSION_CONFLICT',
    type: 'CONFLICT',
    domain: 'HR',
    httpStatus: 409,
    message: '组织架构已变化，请刷新后重试',
  },
  /** 加班批次存在校验未通过的人员，整批不提交（hr PRD §3 全有或全无） */
  OVERTIME_BATCH_REJECTED: {
    code: 'OVERTIME_BATCH_REJECTED',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '加班批次存在校验未通过的人员',
    detailsFields: ['failures'],
  },
  /** 加班员工账号状态异常（非"在职"），逐人失败原因（hr PRD §3） */
  OVERTIME_EMPLOYEE_NOT_ACTIVE: {
    code: 'OVERTIME_EMPLOYEE_NOT_ACTIVE',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '加班员工账号状态异常',
  },
  /** 岗位申请的目标部门或岗位当前不可申请（hr PRD §5：停用/不允许自助申请/不适用于目标部门） */
  POSITION_APPLY_TARGET_UNAVAILABLE: {
    code: 'POSITION_APPLY_TARGET_UNAVAILABLE',
    type: 'BUSINESS',
    domain: 'HR',
    httpStatus: 422,
    message: '目标部门或岗位当前不可申请',
  },
  /** 恢复目标已变化（幂等记录与目标集不符/生命周期版本不符），须重新预览（backstage PRD §3） */
  RESTORE_TARGET_STALE: {
    code: 'RESTORE_TARGET_STALE',
    type: 'CONFLICT',
    domain: 'HR',
    httpStatus: 409,
    message: '恢复目标已变化，请重新预览',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
