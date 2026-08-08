/**
 * 平台级共享枚举（字符串联合类型）。
 *
 * 与各部署单元 Prisma enum 对齐（docs/database-design/00-baseline.md §1）；
 * 跨模块共享的枚举在此统一定义，模块私有枚举保留在各模块 schema / 模块内。
 */

/** 性别（base PRD §6） */
export type Gender = 'MALE' | 'FEMALE';

/** 平台账号状态（base PRD §2） */
export type UserStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'DEACTIVATED';

/** 功能授权数据范围（主 PRD §3.1） */
export type DataScope = 'SELF' | 'DEPARTMENT' | 'COMPANY';

/** 业务系统产品状态（主 PRD §2.1） */
export type ProductStatus = 'OPEN' | 'COMING_SOON';

/** 统一审批状态（主 PRD §3.2） */
export type ApprovalStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** 审批处理动作（主 PRD §3.2，S-17） */
export type ApprovalAction = 'SUBMIT' | 'CANCEL' | 'APPROVE' | 'REJECT' | 'AUTO_CANCEL';

/** 审批取消来源（主 PRD §3.2） */
export type CancelSource = 'USER' | 'ACCOUNT_DEACTIVATED' | 'OVERDUE';

/** 操作日志操作性质（主 PRD §3.3） */
export type LogAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'EXPORT';

/** 用户表格偏好类型（主 PRD §10.2） */
export type TablePrefType = 'FILTER_PRESET' | 'COLUMN_SETTING';

/** 部署单元编码（主 PRD §1.3；BASE 不进入授权目录） */
export type SystemCode = 'BACKSTAGE' | 'ASSET' | 'HR' | 'FIN';
