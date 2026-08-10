import { Inject, Injectable } from '@nestjs/common';
import {
  ASSET_CONFIG_FUNCTION_CODE,
  BusinessException,
  ConsumableQueryDto,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { buildTablePrismaQuery } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';

/** 品种输入（创建/编辑共用字段；类型创建后不可变） */
export interface ConsumableInput {
  name: string;
  categoryId?: number;
  unitId?: number;
  type: 'DISPOSABLE' | 'REUSABLE';
  quotaCycle?: 'MONTH' | 'QUARTER' | 'YEAR';
  quotaLimit?: number;
  returnDays?: number;
  maxHolding?: number;
  referencePrice?: string;
  safetyStock: number;
  imageOssKey?: string;
  remark?: string;
  status?: 'ACTIVE' | 'DISABLED';
  idempotencyKey?: string;
}

/** 品种列表项（含汇总库存） */
export interface ConsumableListItem {
  id: number;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  unitId: number | null;
  unitName: string;
  type: string;
  quotaCycle: string | null;
  quotaLimit: number | null;
  returnDays: number | null;
  maxHolding: number | null;
  referencePrice: string | null;
  safetyStock: number;
  imageOssKey: string | null;
  status: string;
  remark: string | null;
  /** 品种级可用库存合计（Σ 账面 − 占用） */
  availableQty: number;
  /** 低库存标记（可用 < 安全库存） */
  lowStock: boolean;
}

/**
 * 消耗品品种服务（asset PRD §5；A-8）。
 *
 * - 品种类型创建时确定不可变；一次性用品必填周期与数量上限，借还用品必填归还期限
 *   与同时持有上限（表 CHECK 约束兜底）；
 * - 单位在未产生业务事实时可纠正，一旦有入库批次/申请明细/库存流水/借还记录即锁定；
 * - 申领上限/归还期限/同时持有上限只影响之后新提交/新借出（提交时快照）；
 * - 品种删除：存在当前库存、未结清借还或待审批引用时整批拒绝；仅有历史终态引用时
 *   可确认删除（删除后同名可再建并获得新 ID）。
 */
@Injectable()
export class ConsumableService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 品种列表（分页；类型/状态/分类/关键字筛选；申领目录需有可用库存）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async list(query: ConsumableQueryDto): Promise<{ items: ConsumableListItem[]; total: number }> {
    if (query.hasAvailableStock) {
      return this.listAvailableConsumables(query);
    }
    const where: Prisma.ConsumableWhereInput = { status: query.status ?? undefined };
    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }
    if (query.type) {
      where.type = query.type;
    }
    if (query.keyword) {
      where.name = { contains: query.keyword, mode: 'insensitive' };
    }
    const tableQuery = buildTablePrismaQuery(query, {
      id: { prismaField: 'id', type: 'number' },
      name: { prismaField: 'name', type: 'text' },
      categoryId: { prismaField: 'categoryId', type: 'number' },
      unitId: { prismaField: 'unitId', type: 'number' },
      type: { prismaField: 'type', type: 'enum' },
      quotaCycle: { prismaField: 'quotaCycle', type: 'enum' },
      safetyStock: { prismaField: 'safetyStock', type: 'number' },
      status: { prismaField: 'status', type: 'enum' },
      createdAt: { prismaField: 'createdAt', type: 'date' },
      updatedAt: { prismaField: 'updatedAt', type: 'date' },
    });
    const effectiveWhere: Prisma.ConsumableWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.ConsumableWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.consumable.count({ where: effectiveWhere }),
      this.prisma.client.consumable.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.ConsumableOrderByWithRelationInput[] | undefined) ?? { id: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const items = await this.decorateWithStock(rows as unknown as ConsumableListItem[]);
    return { total, items };
  }

  /**
   * 申领页品种汇总：在 SQL 内筛掉未启用或没有可用库存的品种，再进行分页。
   *
   * @param query 品种筛选条件
   * @returns 已按申领资格筛选的品种汇总和总数
   */
  private async listAvailableConsumables(query: ConsumableQueryDto): Promise<{ items: ConsumableListItem[]; total: number }> {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`c.status = 'ACTIVE'`,
      Prisma.sql`
        EXISTS (
          SELECT 1
          FROM asset.inventory_items ii
          WHERE ii.consumable_id = c.id
            AND ii.book_qty > ii.reserved_qty
        )
      `,
    ];
    if (query.categoryId) {
      conditions.push(Prisma.sql`c.category_id = ${query.categoryId}`);
    }
    if (query.type) {
      conditions.push(Prisma.sql`c.type = ${query.type}`);
    }
    if (query.status) {
      conditions.push(Prisma.sql`c.status = ${query.status}`);
    }
    if (query.keyword) {
      conditions.push(Prisma.sql`c.name ILIKE ${`%${query.keyword}%`}`);
    }
    const whereSql = Prisma.join(conditions, ' AND ');
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const [countRows, idRows] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*)::bigint AS total
        FROM asset.consumables c
        WHERE ${whereSql}
      `,
      this.prisma.client.$queryRaw<Array<{ id: number }>>`
        SELECT c.id
        FROM asset.consumables c
        WHERE ${whereSql}
        ORDER BY c.id ASC
        LIMIT ${pageSize} OFFSET ${offset}
      `,
    ]);
    const ids = idRows.map((row) => row.id);
    const rows = await this.prisma.client.consumable.findMany({ where: { id: { in: ids } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const orderedRows = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
    return {
      total: Number(countRows[0]?.total ?? 0),
      items: await this.decorateWithStock(orderedRows as unknown as ConsumableListItem[]),
    };
  }

  /**
   * 创建品种（幂等；名称唯一）。
   *
   * @param operator 操作人
   * @param input 品种输入
   * @returns 品种 id
   * @throws VALIDATION_FAILED 名称重复/参数缺失/分类非法
   */
  async create(operator: AssetOperationLogOperator, input: ConsumableInput): Promise<{ id: number }> {
    this.assertTypeParams(input);
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.consumable.create',
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        const category = await this.loadCategory(tx, input.categoryId);
        const unit = await this.loadUnit(tx, input.unitId);
        try {
          const row = await tx.consumable.create({
            data: {
              name: input.name,
              categoryId: category?.id ?? null,
              categoryName: category?.name ?? null,
              unitId: unit?.id ?? null,
              unitName: unit?.name ?? '',
              type: input.type,
              quotaCycle: input.quotaCycle ?? null,
              quotaLimit: input.quotaLimit ?? null,
              returnDays: input.returnDays ?? null,
              maxHolding: input.maxHolding ?? null,
              referencePrice: input.referencePrice ? new Prisma.Decimal(input.referencePrice) : null,
              safetyStock: input.safetyStock,
              imageOssKey: input.imageOssKey ?? null,
              remark: input.remark ?? null,
              createdBy: operator.id,
            },
          });
          return {
            result: { id: row.id },
            actionType: 'CREATE' as const,
            summary: `新增了消耗品品种：${input.name}（${input.type === 'DISPOSABLE' ? '一次性' : '借还'}）`,
          };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '品种名称已存在' });
          }
          throw error;
        }
      },
    });
  }

  /**
   * 编辑品种（类型与有业务事实后的单位不可变；品类参数只影响之后新提交/新借出）。
   *
   * @param operator 操作人
   * @param id 品种 id
   * @param input 品种输入（type 字段忽略，以既有值为准）
   * @throws RESOURCE_NOT_FOUND 品种不存在；UNIT_LOCKED 单位已锁定
   */
  async update(operator: AssetOperationLogOperator, id: number, input: ConsumableInput, idempotencyKey?: string): Promise<{ ok: true }> {
    this.assertTypeParams(input);
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.consumable.update',
      idempotencyKey,
      fingerprint: fingerprintPayload({ ...input, type: undefined, id }),
      run: async (tx) => {
        const existing = await tx.consumable.findUnique({ where: { id } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 类型创建后不可变（输入 type 仅作参数一致性校验）
        if (input.type !== existing.type) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '品种类型创建后不可变更' });
        }
        if (input.unitId !== existing.unitId) {
          const hasFacts = await this.hasBusinessFacts(tx, id);
          if (hasFacts) {
            throw new BusinessException(inventoryErrors.UNIT_LOCKED);
          }
        }
        const category = await this.loadCategory(tx, input.categoryId);
        const unit = await this.loadUnit(tx, input.unitId);
        const changed: string[] = [];
        const pushChange = (label: string, before: unknown, after: unknown): void => {
          if (String(before ?? '') !== String(after ?? '')) {
            changed.push(`${label}：${String(before ?? '未设置')} → ${String(after ?? '未设置')}`);
          }
        };
        pushChange('名称', existing.name, input.name);
        pushChange('申领上限周期', existing.quotaCycle, input.quotaCycle);
        pushChange('周期上限', existing.quotaLimit, input.quotaLimit);
        pushChange('归还期限', existing.returnDays, input.returnDays);
        pushChange('同时持有上限', existing.maxHolding, input.maxHolding);
        pushChange('安全库存', existing.safetyStock, input.safetyStock);
        pushChange('状态', existing.status, input.status ?? 'ACTIVE');
        await tx.consumable.update({
          where: { id },
          data: {
            name: input.name,
            categoryId: category?.id ?? null,
            categoryName: category?.name ?? null,
            unitId: unit?.id ?? null,
            unitName: unit?.name ?? '',
            quotaCycle: input.quotaCycle ?? null,
            quotaLimit: input.quotaLimit ?? null,
            returnDays: input.returnDays ?? null,
            maxHolding: input.maxHolding ?? null,
            referencePrice: input.referencePrice ? new Prisma.Decimal(input.referencePrice) : null,
            safetyStock: input.safetyStock,
            imageOssKey: input.imageOssKey ?? null,
            remark: input.remark ?? null,
            status: input.status ?? 'ACTIVE',
            updatedBy: operator.id,
          },
        });
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `更新了品种：${input.name}${changed.length > 0 ? `（${changed.join('；')}）` : ''}`,
        };
      },
    });
  }

  /**
   * 品种批量硬删除（当前库存/未结清借还/待审批引用任一存在则整批拒绝；库存条目同时清空）。
   *
   * @param operator 操作人
   * @param ids 品种 id 列表
   * @returns 删除结果
   * @throws CONSUMABLE_REFERENCED 任一品种存在引用
   */
  async batchDelete(operator: AssetOperationLogOperator, ids: readonly number[], idempotencyKey?: string): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.consumable.delete',
      idempotencyKey,
      fingerprint: fingerprintPayload({ ids }),
      run: async (tx) => {
        const rows = await tx.consumable.findMany({ where: { id: { in: [...ids] } } });
        if (rows.length !== ids.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const referenced = await this.countReferenced(tx, ids);
        if (referenced > 0) {
          throw new BusinessException(inventoryErrors.CONSUMABLE_REFERENCED, { referenced });
        }
        // 删除品种前清空其全部库存条目（A-10 FK 约束；条目无库存时才可能走到这里）
        await tx.inventoryItem.deleteMany({ where: { consumableId: { in: [...ids] } } });
        const result = await tx.consumable.deleteMany({ where: { id: { in: [...ids] } } });
        return {
          result: { deleted: result.count },
          actionType: 'DELETE' as const,
          summary: `删除了 ${result.count} 个品种`,
        };
      },
    });
  }

  /**
   * 批量加载品种汇总库存（可用 = Σ 账面 − 占用；低库存标记 = 可用 < 安全库存）。
   *
   * @param rows 品种行（Prisma findMany 结果）
   * @returns 品种列表项（金额规范化为两位小数字符串）
   */
  private async decorateWithStock(rows: ConsumableListItem[]): Promise<ConsumableListItem[]> {
    if (rows.length === 0) {
      return [];
    }
    const stockRows = await this.prisma.client.$queryRaw<Array<{ consumable_id: number; available: bigint }>>`
      SELECT consumable_id, SUM(book_qty - reserved_qty) AS available
      FROM asset.inventory_items
      WHERE consumable_id = ANY(${rows.map((row) => row.id) as number[]})
      GROUP BY consumable_id
    `;
    const stockByConsumable = new Map(stockRows.map((row) => [Number(row.consumable_id), Number(row.available)]));
    return rows.map((row) => {
      const availableQty = stockByConsumable.get(row.id) ?? 0;
      return {
        ...row,
        referencePrice: row.referencePrice !== null && row.referencePrice !== undefined ? Number(row.referencePrice).toFixed(2) : null,
        availableQty,
        lowStock: availableQty < row.safetyStock,
      };
    });
  }

  /**
   * 校验品种类型与参数一致性（一次性必填周期+上限；借还必填期限+持有上限）。
   *
   * @param input 品种输入
   * @throws VALIDATION_FAILED 参数缺失
   */
  private assertTypeParams(input: ConsumableInput): void {
    if (input.type === 'DISPOSABLE' && (input.quotaCycle === undefined || input.quotaLimit === undefined)) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '一次性用品必须填写申领上限周期与数量上限' });
    }
    if (input.type === 'REUSABLE' && (input.returnDays === undefined || input.maxHolding === undefined)) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '借还用品必须填写归还期限与同时持有上限' });
    }
  }

  /**
   * 加载分类（必须是"消耗品"顶级分类下的一级子分类）。
   *
   * @param tx 事务客户端
   * @param categoryId 分类 id
   * @returns 分类行；未填返回 null
   * @throws VALIDATION_FAILED 分类不存在或不属于消耗品分类
   */
  private async loadCategory(
    tx: Prisma.TransactionClient,
    categoryId?: number,
  ): Promise<{ id: number; name: string } | null> {
    if (categoryId === undefined) {
      return null;
    }
    const rows = await tx.$queryRaw<Array<{ id: number; name: string }>>`
      SELECT c.id, c.name
      FROM asset.asset_categories c
      INNER JOIN asset.asset_categories top ON top.id = c.parent_id
      WHERE c.id = ${categoryId}
        AND top.name = '消耗品'
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '分类不存在或不是消耗品分类' });
    }
    return rows[0] ?? null;
  }

  /**
   * 加载单位字典项（UNIT 类型）。
   *
   * @param tx 事务客户端
   * @param unitId 字典项 id
   * @returns 单位行；未填返回 null
   * @throws VALIDATION_FAILED 字典项不存在或不是单位
   */
  private async loadUnit(tx: Prisma.TransactionClient, unitId?: number): Promise<{ id: number; name: string } | null> {
    if (unitId === undefined) {
      return null;
    }
    const row = await tx.assetDictItem.findFirst({ where: { id: unitId, dictType: 'UNIT' } });
    if (!row) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '单位不存在或不是单位类型' });
    }
    return { id: row.id, name: row.name };
  }

  /**
   * 品种是否已产生业务事实（入库批次/申请明细/库存流水/借还记录任一存在）。
   *
   * @param tx 事务客户端
   * @param consumableId 品种 id
   * @returns 是否已有业务事实
   */
  private async hasBusinessFacts(tx: Prisma.TransactionClient, consumableId: number): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ total: bigint }>>`
      SELECT (
        (SELECT COUNT(*) FROM asset.batches WHERE consumable_id = ${consumableId}) +
        (SELECT COUNT(*) FROM asset.stock_in_items WHERE consumable_id = ${consumableId}) +
        (SELECT COUNT(*) FROM asset.stock_flows sf
          INNER JOIN asset.inventory_items ii ON ii.id = sf.inventory_item_id
          WHERE ii.consumable_id = ${consumableId})
      ) AS total
    `;
    return Number(rows[0]?.total ?? 0) > 0;
  }

  /**
   * 统计品种引用数（当前库存条目 / 未结清借还 / 待审批申请明细）。
   *
   * @param tx 事务客户端
   * @param ids 品种 id 集合
   * @returns 引用总数
   */
  private async countReferenced(tx: Prisma.TransactionClient, ids: readonly number[]): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ total: bigint }>>`
      SELECT (
        (SELECT COUNT(*) FROM asset.inventory_items WHERE consumable_id = ANY(${ids as number[]})
          AND (book_qty > 0 OR reserved_qty > 0)) +
        (SELECT COUNT(*) FROM asset.borrow_records br
          INNER JOIN asset.inventory_items ii ON ii.id = br.inventory_item_id
          WHERE ii.consumable_id = ANY(${ids as number[]})
            AND (br.qty - br.returned_qty - br.written_off_qty) > 0) +
        (SELECT COUNT(*) FROM asset.stock_in_items si
          INNER JOIN asset.approval_requests r ON r.id = si.request_id
          WHERE si.consumable_id = ANY(${ids as number[]})
            AND r.status = 'PENDING') +
        (SELECT COUNT(*) FROM asset.consumable_request_items cri
          INNER JOIN asset.approval_requests r ON r.id = cri.request_id
          INNER JOIN asset.inventory_items ii ON ii.id = cri.inventory_item_id
          WHERE ii.consumable_id = ANY(${ids as number[]})
            AND r.status = 'PENDING')
      ) AS total
    `;
    return Number(rows[0]?.total ?? 0);
  }
}
