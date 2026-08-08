import { accountErrors } from './domains/account';
import { approvalErrors } from './domains/approval';
import { assetErrors } from './domains/asset';
import { backupErrors } from './domains/backup';
import { exportErrors } from './domains/export';
import { financeErrors } from './domains/finance';
import { frameworkErrors } from './domains/framework';
import { hrErrors } from './domains/hr';
import { integrationErrors } from './domains/integration';
import { inventoryErrors } from './domains/inventory';
import { permissionErrors } from './domains/permission';
import type { BusinessDomain, ErrorEntry, ErrorType } from './types';

/** 全部错误目录（每个域一张表；framework 为无业务域的通用错误） */
export const ERROR_CATALOG: Readonly<Record<string, readonly ErrorEntry[]>> = {
  framework: Object.values(frameworkErrors),
  ACCOUNT: Object.values(accountErrors),
  PERMISSION: Object.values(permissionErrors),
  APPROVAL: Object.values(approvalErrors),
  ASSET: Object.values(assetErrors),
  INVENTORY: Object.values(inventoryErrors),
  HR: Object.values(hrErrors),
  FINANCE: Object.values(financeErrors),
  EXPORT: Object.values(exportErrors),
  BACKUP: Object.values(backupErrors),
  INTEGRATION: Object.values(integrationErrors),
};

/**
 * 按 (type, domain, code) 精确查找目录项。
 * @param type   错误大类
 * @param domain 业务域；framework 通用错误传入 undefined
 * @param code   机器可读编码
 * @returns 目录项；未注册时返回 undefined（全局过滤器应降级为 SYSTEM 处理）
 */
export function getErrorEntry(
  type: ErrorType,
  domain: BusinessDomain | undefined,
  code: string,
): ErrorEntry | undefined {
  const table = domain ? ERROR_CATALOG[domain] : ERROR_CATALOG.framework;
  return table?.find((entry) => entry.type === type && entry.code === code);
}
