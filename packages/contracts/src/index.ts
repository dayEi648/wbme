/**
 * @wbme/contracts 包入口：全平台共享契约（主 PRD §9.5/§9.6/§9.10/§9.11）。
 *
 * 导出：统一错误契约（类型、目录、BusinessException）、DTO 基类与分页约定、
 * 平台级共享枚举、功能权限目录权威定义（主 PRD §3.1）、金额/比率十进制字符串约定、时区与时间序列化约定。
 */

export * from './errors/types';
export * from './errors/business-exception';
export * from './errors/catalog';
export * from './errors/domains/framework';
export * from './errors/domains/account';
export * from './errors/domains/permission';
export * from './errors/domains/approval';
export * from './errors/domains/asset';
export * from './errors/domains/inventory';
export * from './errors/domains/hr';
export * from './errors/domains/finance';
export * from './errors/domains/export';
export * from './errors/domains/backup';
export * from './errors/domains/integration';
export * from './dto/base.dto';
export * from './enums/common';
export * from './permission/catalog';
export * from './money';
export * from './phone';
export * from './time';
