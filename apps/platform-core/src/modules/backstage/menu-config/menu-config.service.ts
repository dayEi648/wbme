import { Injectable } from '@nestjs/common';
import {
  ASSET_CONFIG_FUNCTION_CODE,
  BusinessException,
  FINANCE_CONFIG_FUNCTION_CODE,
  frameworkErrors,
  HR_CONFIG_FUNCTION_CODE,
  permissionErrors,
  SYSTEM_SETTINGS_FUNCTION_CODE,
  type SystemCode,
} from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';
import { AuthorizationService } from '../permission/authorization.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../permission/operation-log.util';
import type { SaveSystemMenuConfigDto } from './menu-config.dto';

/**
 * 菜单配置写操作的功能权限映射：菜单管理入口在各系统「系统设置」内，
 * 复用各系统既有配置功能码，不新增权限点（主 PRD §2.1）。
 */
const MENU_CONFIG_FUNCTION_CODES: Readonly<Record<SystemCode, string>> = {
  BACKSTAGE: SYSTEM_SETTINGS_FUNCTION_CODE,
  ASSET: ASSET_CONFIG_FUNCTION_CODE,
  HR: HR_CONFIG_FUNCTION_CODE,
  FIN: FINANCE_CONFIG_FUNCTION_CODE,
};

/** 菜单分组展示配置行（API 出参/入库结构） */
export interface MenuGroupConfigRow {
  nodeKey: string;
  parentKey: string | null;
  nameOverride: string | null;
  sortOrder: number;
}

/** 菜单项展示配置行（API 出参/入库结构） */
export interface MenuItemConfigRow {
  itemKey: string;
  parentKey: string | null;
  nameOverride: string | null;
  sortOrder: number;
}

/** 某系统的菜单展示配置（整树） */
export interface SystemMenuConfig {
  groups: MenuGroupConfigRow[];
  items: MenuItemConfigRow[];
}

/** 改名覆盖规整：去除首尾空白；空白串视为未覆盖（恢复默认名） */
function normalizeNameOverride(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function invalidStructure(reason: string): never {
  throw new BusinessException(permissionErrors.MENU_CONFIG_STRUCTURE_INVALID, { reason });
}

/**
 * 结构校验 + 规整（纯函数，单测直接覆盖）：
 * 标识唯一、引用闭合（分组父引用同载荷内分组、不引用自身、不成环；菜单项引用已声明分组）。
 * 分组可嵌套到任意深度，唯一限制是防环。sortOrder 连续性不强制——同级相对顺序即语义。
 */
export function normalizeAndValidateMenuConfig(dto: SaveSystemMenuConfigDto): SystemMenuConfig {
  const groups: MenuGroupConfigRow[] = dto.groups.map((row) => ({
    nodeKey: row.nodeKey,
    parentKey: row.parentKey ?? null,
    nameOverride: normalizeNameOverride(row.nameOverride),
    sortOrder: row.sortOrder,
  }));
  const items: MenuItemConfigRow[] = dto.items.map((row) => ({
    itemKey: row.itemKey,
    parentKey: row.parentKey ?? null,
    nameOverride: normalizeNameOverride(row.nameOverride),
    sortOrder: row.sortOrder,
  }));

  const groupKeys = new Set<string>();
  for (const group of groups) {
    if (groupKeys.has(group.nodeKey)) {
      invalidStructure(`分组标识重复：${group.nodeKey}`);
    }
    groupKeys.add(group.nodeKey);
  }
  const itemKeys = new Set<string>();
  for (const item of items) {
    if (itemKeys.has(item.itemKey)) {
      invalidStructure(`菜单项标识重复：${item.itemKey}`);
    }
    itemKeys.add(item.itemKey);
  }

  const groupByKey = new Map(groups.map((group) => [group.nodeKey, group]));
  for (const group of groups) {
    if (group.parentKey === null) continue;
    if (group.parentKey === group.nodeKey) {
      invalidStructure(`分组不能作为自己的父分组：${group.nodeKey}`);
    }
    if (!groupByKey.has(group.parentKey)) {
      invalidStructure(`分组的父分组不存在：${group.nodeKey}`);
    }
  }
  // 环检测：沿 parentKey 链向上走，重复遇到任一节点即成环
  for (const group of groups) {
    const visited = new Set<string>([group.nodeKey]);
    let cursor = group.parentKey;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        invalidStructure(`分组层级存在循环：${group.nodeKey}`);
      }
      visited.add(cursor);
      cursor = groupByKey.get(cursor)?.parentKey ?? null;
    }
  }
  for (const item of items) {
    if (item.parentKey !== null && !groupKeys.has(item.parentKey)) {
      invalidStructure(`菜单项所属分组不存在：${item.itemKey}`);
    }
  }

  return { groups, items };
}

/**
 * 系统导航菜单展示配置（主 PRD §2.1 菜单管理）。
 *
 * 代码仍是菜单项目录的唯一事实（key/path/默认名/权限）；本服务只持久化展示层配置
 * （排序/分组归属与层级/中文名覆盖），读取由前端与代码默认合并。整树单事务替换，
 * 重要写操作经 executeIdempotentOperation 幂等并落操作日志（主 PRD §9.5/§3.3）。
 */
@Injectable()
export class MenuConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  /** 读取某系统菜单展示配置（登录即可读：所有用户都要渲染菜单；从未配置时返回空集合） */
  async list(systemCode: string): Promise<SystemMenuConfig> {
    const code = parseSystemCode(systemCode);
    const [groups, items] = await Promise.all([
      this.prisma.client.systemMenuGroup.findMany({
        where: { systemCode: code },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.client.systemMenuItem.findMany({
        where: { systemCode: code },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      groups: groups.map((row) => ({
        nodeKey: row.nodeKey,
        parentKey: row.parentKey,
        nameOverride: row.nameOverride,
        sortOrder: row.sortOrder,
      })),
      items: items.map((row) => ({
        itemKey: row.itemKey,
        parentKey: row.parentKey,
        nameOverride: row.nameOverride,
        sortOrder: row.sortOrder,
      })),
    };
  }

  /** 整树替换保存某系统菜单展示配置 */
  async save(operatorId: number, systemCode: string, dto: SaveSystemMenuConfigDto): Promise<SystemMenuConfig> {
    const code = parseSystemCode(systemCode);
    const functionCode = await this.assertConfigAccess(operatorId, code);
    const config = normalizeAndValidateMenuConfig(dto);
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: functionCode,
      scope: 'menu_config.save',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload({ systemCode: code, ...config }),
      run: async (tx) => {
        await tx.systemMenuItem.deleteMany({ where: { systemCode: code } });
        await tx.systemMenuGroup.deleteMany({ where: { systemCode: code } });
        if (config.groups.length > 0) {
          await tx.systemMenuGroup.createMany({
            data: config.groups.map((row) => ({ systemCode: code, ...row, updatedBy: operatorId })),
          });
        }
        if (config.items.length > 0) {
          await tx.systemMenuItem.createMany({
            data: config.items.map((row) => ({ systemCode: code, ...row, updatedBy: operatorId })),
          });
        }
        return {
          result: config,
          actionType: 'UPDATE',
          summary: `保存 ${code} 系统菜单配置（分组 ${config.groups.length} 行、菜单项 ${config.items.length} 行）`,
        };
      },
    });
  }

  /** 恢复默认：删除该系统全部展示配置行，前端回退代码默认菜单 */
  async reset(operatorId: number, systemCode: string, idempotencyKey?: string): Promise<SystemMenuConfig> {
    const code = parseSystemCode(systemCode);
    const functionCode = await this.assertConfigAccess(operatorId, code);
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const empty: SystemMenuConfig = { groups: [], items: [] };
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: functionCode,
      scope: 'menu_config.reset',
      idempotencyKey,
      fingerprint: fingerprintPayload({ systemCode: code, reset: true }),
      run: async (tx) => {
        await tx.systemMenuItem.deleteMany({ where: { systemCode: code } });
        await tx.systemMenuGroup.deleteMany({ where: { systemCode: code } });
        return { result: empty, actionType: 'DELETE', summary: `恢复 ${code} 系统默认菜单` };
      },
    });
  }

  /**
   * 写操作鉴权：功能码随系统参数动态映射，无法使用静态 @RequireFunction，
   * 此处与 FunctionPermissionGuard 同口径（目录注册 → 系统开放 → 功能授权）。
   */
  private async assertConfigAccess(userId: number, systemCode: SystemCode): Promise<string> {
    const functionCode = MENU_CONFIG_FUNCTION_CODES[systemCode];
    const access = await this.authorization.getFunctionAccess(userId, functionCode);
    if (!access.registered) {
      throw new BusinessException(frameworkErrors.INTERNAL_ERROR);
    }
    if (!access.systemOpen) {
      throw new BusinessException(frameworkErrors.SYSTEM_NOT_OPEN, { system: access.systemName });
    }
    if (!access.allowed) {
      throw new BusinessException(frameworkErrors.FORBIDDEN);
    }
    return functionCode;
  }
}

/** 校验 path 参数为四系统之一（其他值一律 404，不暴露合法编码清单语义） */
function parseSystemCode(raw: string): SystemCode {
  if (raw === 'BACKSTAGE' || raw === 'ASSET' || raw === 'HR' || raw === 'FIN') {
    return raw;
  }
  throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
}
