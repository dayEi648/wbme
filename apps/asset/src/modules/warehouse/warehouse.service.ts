import { Inject, Injectable } from '@nestjs/common';
import {
  ASSET_CONFIG_FUNCTION_CODE,
  BusinessException,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
// 库位删除/停用错误码见 inventoryErrors（INVENTORY 域）
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';

/** 库位树节点（对外输出） */
export interface WarehouseTreeNode {
  id: number;
  parentId: number | null;
  name: string;
  sort: number;
  status: string;
  children: WarehouseTreeNode[];
}

/**
 * 库位服务（asset PRD §5；A-9）。
 *
 * 全公司统一层级库位树：新建、编辑、排序、停用和批量硬删除；禁止形成父子循环；
 * 存在未删除子库位时禁止删除父库位（FK RESTRICT 兜底）；库位停用后不能作为新入库
 * 或调拨目标，但现存库存、历史批次与流水继续显示（快照语义）；库位改名/移动节点
 * 只改变当前树，历史快照不追溯改写。
 */
@Injectable()
export class WarehouseService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 库位树全量列表。
   *
   * @returns 树形结构（根 → 全部子孙）
   */
  async tree(): Promise<{ items: WarehouseTreeNode[] }> {
    const rows = await this.prisma.client.warehouse.findMany({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
    return { items: buildTree(rows as unknown as WarehouseTreeNode[]) };
  }

  /**
   * 创建库位（幂等；禁止形成父子循环）。
   *
   * @param operator 操作人
   * @param input 库位输入
   * @returns 库位 id
   * @throws VALIDATION_FAILED 父库位不存在
   */
  async create(
    operator: AssetOperationLogOperator,
    input: { parentId?: number; name: string; sort?: number; idempotencyKey?: string },
  ): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.warehouse.create',
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        if (input.parentId !== undefined) {
          const parent = await tx.warehouse.findUnique({ where: { id: input.parentId } });
          if (!parent) {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '父库位不存在' });
          }
        }
        const row = await tx.warehouse.create({
          data: {
            parentId: input.parentId ?? null,
            name: input.name,
            sort: input.sort ?? 0,
            createdBy: operator.id,
          },
        });
        return {
          result: { id: row.id },
          actionType: 'CREATE' as const,
          summary: `新增了库位：${input.name}`,
        };
      },
    });
  }

  /**
   * 编辑库位（名称/排序/状态/移动节点；移动禁止形成父子循环）。
   *
   * @param operator 操作人
   * @param id 库位 id
   * @param input 库位输入
   * @throws RESOURCE_NOT_FOUND 库位不存在；VALIDATION_FAILED 移动形成循环
   */
  async update(
    operator: AssetOperationLogOperator,
    id: number,
    input: { parentId?: number; name: string; sort: number; status: 'ACTIVE' | 'DISABLED' },
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.warehouse.update',
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        const existing = await tx.warehouse.findUnique({ where: { id } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await this.assertNoCycle(tx, id, input.parentId ?? null);
        await tx.warehouse.update({
          where: { id },
          data: {
            parentId: input.parentId ?? null,
            name: input.name,
            sort: input.sort,
            status: input.status,
            updatedBy: operator.id,
          },
        });
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `更新了库位：${existing.name} → ${input.name}`,
        };
      },
    });
  }

  /**
   * 库位批量硬删除（存在未删除子库位或现存库存条目/未结清借还/待审批引用时整批拒绝）。
   *
   * @param operator 操作人
   * @param ids 库位 id 列表
   * @returns 删除结果
   * @throws LOCATION_HAS_CHILDREN / LOCATION_REFERENCED 任一库位不满足
   */
  async batchDelete(operator: AssetOperationLogOperator, ids: readonly number[]): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.warehouse.delete',
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload({ ids }),
      run: async (tx) => {
        const rows = await tx.warehouse.findMany({ where: { id: { in: [...ids] } } });
        if (rows.length !== ids.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const children = await tx.warehouse.count({ where: { parentId: { in: [...ids] } } });
        if (children > 0) {
          throw new BusinessException(inventoryErrors.LOCATION_HAS_CHILDREN, { children });
        }
        const referenced = await this.countReferenced(tx, ids);
        if (referenced > 0) {
          throw new BusinessException(inventoryErrors.LOCATION_REFERENCED, { referenced });
        }
        const result = await tx.warehouse.deleteMany({ where: { id: { in: [...ids] } } });
        return {
          result: { deleted: result.count },
          actionType: 'DELETE' as const,
          summary: `删除了 ${result.count} 个库位`,
        };
      },
    });
  }

  /**
   * 移动节点循环校验：新父库位不能是节点自身或其子孙。
   *
   * @param tx 事务客户端
   * @param nodeId 被移动节点 id
   * @param newParentId 目标父库位 id
   * @throws VALIDATION_FAILED 形成循环
   */
  private async assertNoCycle(tx: Prisma.TransactionClient, nodeId: number, newParentId: number | null): Promise<void> {
    if (newParentId === null || newParentId === nodeId) {
      if (newParentId === nodeId) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '库位不能以自身作为父节点' });
      }
      return;
    }
    // 从目标父库位沿父链上溯，若遇到节点自身则成环（树深度受 FK 约束必然有界）
    let current: number | null = newParentId;
    while (current !== null) {
      if (current === nodeId) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '库位树不能形成父子循环' });
      }
      const parent: { parentId: number | null } | null = await tx.warehouse.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      current = parent?.parentId ?? null;
    }
  }

  /**
   * 统计库位引用数（现存库存条目 / 未结清借还 / 待审批引用——批次与流水只保存名称
   * 快照不参与删除检查；删除前展示现存库存条目数、未结清借还数和待审批引用数）。
   *
   * @param tx 事务客户端
   * @param ids 库位 id 集合
   * @returns 引用总数
   */
  private async countReferenced(tx: Prisma.TransactionClient, ids: readonly number[]): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ total: bigint }>>`
      SELECT (
        (SELECT COUNT(*) FROM asset.inventory_items WHERE warehouse_id = ANY(${ids as number[]})
          AND (book_qty > 0 OR reserved_qty > 0)) +
        (SELECT COUNT(*) FROM asset.borrow_records br
          INNER JOIN asset.inventory_items ii ON ii.id = br.inventory_item_id
          WHERE ii.warehouse_id = ANY(${ids as number[]})
            AND (br.qty - br.returned_qty - br.written_off_qty) > 0) +
        (SELECT COUNT(*) FROM asset.consumable_request_items cri
          INNER JOIN asset.approval_requests r ON r.id = cri.request_id
          INNER JOIN asset.inventory_items ii ON ii.id = cri.inventory_item_id
          WHERE ii.warehouse_id = ANY(${ids as number[]})
            AND r.status = 'PENDING') +
        (SELECT COUNT(*) FROM asset.stock_in_items sii
          INNER JOIN asset.approval_requests r ON r.id = sii.request_id
          WHERE sii.warehouse_id = ANY(${ids as number[]})
            AND r.status = 'PENDING')
      ) AS total
    `;
    return Number(rows[0]?.total ?? 0);
  }
}

/**
 * 把平铺库位行组装为树（顶层 = parentId 为 null 或指向不在集合内的父节点）。
 *
 * @param rows 平铺行
 * @returns 树根列表
 */
function buildTree(rows: WarehouseTreeNode[]): WarehouseTreeNode[] {
  const byId = new Map<number, WarehouseTreeNode>(rows.map((row) => [row.id, { ...row, children: [] }]));
  const roots: WarehouseTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId !== null && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
