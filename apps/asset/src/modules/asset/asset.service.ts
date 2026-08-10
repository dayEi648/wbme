import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import {
  BusinessException,
  FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
  FIXED_ASSET_VIEW_FUNCTION_CODE,
  MY_ASSETS_FUNCTION_CODE,
  AssetBatchDeleteDto,
  AssetCreateDto,
  AssetQueryDto,
  AssetScheduleDto,
  AssetUpdateDto,
  MyAssetQueryDto,
  assetErrors,
  frameworkErrors,
} from '@wbme/contracts';
import { buildTablePrismaQuery, RedisService, runExport } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { getFunctionAccess, widestScope } from '../../shared/cross-schema-auth';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadAssetOperationLogOperator,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';

/** 资产台账行（详情输出） */
export interface AssetDetail {
  id: number;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  specModel: string | null;
  amount: string;
  purchaseAt: Date | null;
  usageStatus: string;
  ownership: string;
  ownerName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  responsibleUserId: number | null;
  responsibleUserName: string | null;
  currentUserId: number | null;
  currentUserName: string | null;
  imageOssKey: string | null;
  remark: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 固定资产台账服务（asset PRD §4；A-3/A-4/A-5）。
 *
 * - 台账状态机：闲置/使用中可普通编辑互切；待维修/维修中只由维修管理产生和流转；
 *   已报废是业务状态（继续显示在台账、可筛选），可通过编辑恢复为闲置/使用中；
 * - 责任人和所属部门的变化必须产生调度记录（A-4），不能被普通编辑绕过；调度目标
 *   责任人必须属于目标部门；部门和责任人均未变化不允许提交；
 * - 变更记录（A-5）只追加：普通编辑/报废/恢复记录字段前后值与操作人，不直接改变
 *   状态语义（待维修/维修中由维修管理驱动）；
 * - 批量软删除：仍在使用或有业务关联的资产整批拒绝；
 * - 部门范围维护者：建档/编辑/调度/报废/删除的目标部门须在授权闭包内。
 */
@Injectable()
export class AssetService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly closures: DepartmentClosureService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 我的资产（本人档：责任人或使用者为当前用户；按我负责的/我使用的/全部筛选，
   * 同一资产同时命中两类时合并为一条）。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @returns items + total
   */
  async listMine(userId: number, query: MyAssetQueryDto): Promise<{ items: AssetDetail[]; total: number }> {
    const access = await getFunctionAccess(this.prisma.client, userId, MY_ASSETS_FUNCTION_CODE);
    if (!access.registered || !access.systemOpen || !access.allowed) {
      return { items: [], total: 0 };
    }
    const where: Prisma.AssetWhereInput = { deletedAt: null };
    if (query.scope === 'OWNED') {
      where.responsibleUserId = userId;
    } else if (query.scope === 'USED') {
      where.currentUserId = userId;
    } else {
      where.OR = [{ responsibleUserId: userId }, { currentUserId: userId }];
    }
    if (query.usageStatus) {
      where.usageStatus = query.usageStatus;
    }
    return this.paginate(where, query.page ?? 1, query.pageSize ?? 20);
  }

  /**
   * 台账分页列表（固定资产查看/维护，部门/公司档；不含逻辑删除）。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @returns items + total
   */
  async list(userId: number, query: AssetQueryDto): Promise<{ items: AssetDetail[]; total: number }> {
    const where = await this.buildListWhere(userId, query);
    const tableQuery = this.tableQuery(query);
    const effectiveWhere: Prisma.AssetWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.AssetWhereInput] }
      : where;
    return this.paginate(effectiveWhere, query.page ?? 1, query.pageSize ?? 20, tableQuery.orderBy as Prisma.AssetOrderByWithRelationInput[] | undefined);
  }

  /**
   * 台账导出（runExport：Redis 互斥 + REPEATABLE READ + 120s 超时；
   * 行数上限 = 平台设置 export.max.rows；导出所有未逻辑删除数据或导出全部筛选结果）。
   *
   * @param userId 当前用户
   * @param query 筛选（与列表一致）
   * @param res Express 响应（流式写回）
   */
  async export(userId: number, query: AssetQueryDto, res: Response): Promise<void> {
    const where = await this.buildListWhere(userId, query);
    const tableQuery = this.tableQuery(query);
    const effectiveWhere: Prisma.AssetWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.AssetWhereInput] }
      : where;
    const maxRows = await this.readExportMaxRows();
    await runExport<AssetDetail>({
      userId,
      redis: this.redis.redis,
      maxRows,
      filename: 'fixed-assets.xlsx',
      columns: [
        { header: '资产ID', value: (row) => row.id },
        { header: '名称', value: (row) => row.name },
        { header: '分类', value: (row) => row.categoryName ?? '' },
        { header: '规格型号', value: (row) => row.specModel ?? '' },
        { header: '金额(元)', value: (row) => row.amount },
        { header: '入库时间', value: (row) => (row.purchaseAt ? row.purchaseAt.toISOString().slice(0, 10) : '') },
        { header: '使用状态', value: (row) => row.usageStatus },
        { header: '归属', value: (row) => (row.ownership === 'COMPANY' ? '公司自有' : row.ownerName ?? '合作方') },
        { header: '所属部门', value: (row) => row.departmentName ?? '' },
        { header: '责任人', value: (row) => row.responsibleUserName ?? '' },
        { header: '使用者', value: (row) => row.currentUserName ?? '' },
        { header: '备注', value: (row) => row.remark ?? '' },
      ],
      transaction: (fn, options) =>
        this.prisma.client.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: options?.timeout,
        }),
      fetchCount: async (tx) => (tx as PrismaService['client']).asset.count({ where: effectiveWhere }),
      fetchRows: async (tx, offset, limit) => {
        const client = tx as PrismaService['client'];
        const rows = await client.asset.findMany({
          where: effectiveWhere,
          orderBy: (tableQuery.orderBy as Prisma.AssetOrderByWithRelationInput[] | undefined) ?? { id: 'desc' },
          skip: offset,
          take: limit,
        });
        return rows.map((row) => ({ ...row, amount: row.amount.toFixed(2) }));
      },
      res,
    });
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    await this.prisma.client.assetOperationLog.create({
      data: {
        operatorId: operator.id,
        operatorName: operator.name,
        operatorDepartments: operator.departments as Prisma.InputJsonValue,
        system: 'ASSET',
        feature: FIXED_ASSET_VIEW_FUNCTION_CODE,
        actionType: 'EXPORT',
        summary: '导出了固定资产台账',
      },
    });
  }

  /** 列表/导出共用查询条件（查看/维护任一授权；取两项授权中最宽的数据范围） */
  private async buildListWhere(userId: number, query: AssetQueryDto): Promise<Prisma.AssetWhereInput> {
    const accesses = await Promise.all([
      getFunctionAccess(this.prisma.client, userId, FIXED_ASSET_VIEW_FUNCTION_CODE),
      getFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE),
    ]);
    const granted = accesses.filter((access) => access.registered && access.allowed);
    if (granted.length === 0) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const available = granted.filter((access) => access.systemOpen);
    if (available.length === 0) {
      throw new BusinessException(frameworkErrors.SYSTEM_NOT_OPEN, { system: granted[0]?.systemName });
    }
    const scope = available.some((access) => access.dataScope === null)
      ? null
      : widestScope(available.flatMap((access) => (access.dataScope ? [access.dataScope] : [])));
    const where: Prisma.AssetWhereInput = { deletedAt: null };
    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }
    if (query.departmentId) {
      where.departmentId = query.departmentId;
    }
    if (query.usageStatus) {
      where.usageStatus = query.usageStatus;
    }
    if (query.ownership) {
      where.ownership = query.ownership;
    }
    if (query.responsibleUserId) {
      where.responsibleUserId = query.responsibleUserId;
    }
    if (query.currentUserId) {
      where.currentUserId = query.currentUserId;
    }
    if (query.keyword) {
      where.OR = [
        { name: { contains: query.keyword, mode: 'insensitive' } },
        { specModel: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    // 数据范围与用户筛选相交，绝不可用数据范围条件覆盖请求中的部门筛选。
    if (scope === 'DEPARTMENT') {
      const closure = await this.closures.closureOfUser(userId);
      where.AND = [{ departmentId: { in: [...closure] } }];
    } else if (scope === 'SELF') {
      where.AND = [{ OR: [{ responsibleUserId: userId }, { currentUserId: userId }] }];
    }
    return where;
  }

  /** 固定资产列表允许的结构化字段白名单；金额 numeric 不以 JavaScript number 参与比较。 */
  private tableQuery(query: AssetQueryDto) {
    return buildTablePrismaQuery(query, {
      id: { prismaField: 'id', type: 'number' },
      keyword: { prismaField: ['name', 'specModel'] as const, type: 'text' },
      name: { prismaField: 'name', type: 'text' },
      categoryId: { prismaField: 'categoryId', type: 'number' },
      specModel: { prismaField: 'specModel', type: 'text' },
      purchaseAt: { prismaField: 'purchaseAt', type: 'date' },
      usageStatus: { prismaField: 'usageStatus', type: 'enum' },
      ownership: { prismaField: 'ownership', type: 'enum' },
      departmentId: { prismaField: 'departmentId', type: 'number' },
      responsibleUserId: { prismaField: 'responsibleUserId', type: 'number' },
      currentUserId: { prismaField: 'currentUserId', type: 'number' },
      createdAt: { prismaField: 'createdAt', type: 'date' },
      updatedAt: { prismaField: 'updatedAt', type: 'date' },
    });
  }

  /** 读平台设置 export.max.rows（经只读视图；缺省 100000） */
  private async readExportMaxRows(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<Array<{ value: string }>>`
      SELECT value FROM backstage.platform_settings WHERE key = 'export.max.rows' LIMIT 1
    `;
    const value = Number(rows[0]?.value ?? 100000);
    return Number.isFinite(value) && value > 0 ? value : 100000;
  }

  /**
   * 资产详情（含调度历史、变更历史与维修单）。
   *
   * @param userId 当前用户
   * @param id 资产 id
   * @returns 详情
   */
  async detail(userId: number, id: number): Promise<unknown> {
    const asset = await this.prisma.client.asset.findUnique({
      where: { id },
      include: {
        transfers: { orderBy: { createdAt: 'desc' } },
        changes: { orderBy: { createdAt: 'desc' } },
        repairOrders: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!asset || asset.deletedAt !== null) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    await this.assertViewAccess(userId, asset);
    return {
      ...asset,
      amount: asset.amount.toFixed(2),
    };
  }

  /**
   * 建档（幂等；金额必填；所属部门/责任人初始设置）。
   *
   * @param operator 操作人
   * @param userId 当前用户
   * @param dto 建档输入
   * @returns 资产 id
   */
  async create(operator: AssetOperationLogOperator, userId: number, dto: AssetCreateDto): Promise<{ id: number }> {
    await this.assertMaintainScope(userId, dto.departmentId);
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
      scope: 'asset.fixed.create',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        const prepared = await this.prepareSnapshot(tx, dto);
        const row = await tx.asset.create({
          data: {
            name: prepared.name,
            categoryId: prepared.categoryId,
            categoryName: prepared.categoryName,
            specModel: prepared.specModel,
            amount: new Prisma.Decimal(dto.amount),
            purchaseAt: prepared.purchaseAt,
            ownership: dto.ownership,
            ownerName: dto.ownerName ?? null,
            departmentId: prepared.departmentId,
            departmentName: prepared.departmentName,
            responsibleUserId: 'responsibleUserId' in dto ? (dto.responsibleUserId ?? null) : null,
            responsibleUserName: prepared.responsibleUserName,
            currentUserId: dto.currentUserId ?? null,
            currentUserName: prepared.currentUserName,
            imageOssKey: dto.imageOssKey ?? null,
            remark: dto.remark ?? null,
            createdBy: operator.id,
          },
        });
        return {
          result: { id: row.id },
          actionType: 'CREATE' as const,
          summary: `新建了固定资产：${prepared.name}`,
        };
      },
    });
  }

  /**
   * 基础资料编辑（责任人与所属部门不在编辑内——变化必须走调度；状态仅 IDLE/IN_USE
   * 互切或从 SCRAPPED 恢复；变更记录 A-5 只追加）。
   *
   * @param operator 操作人
   * @param userId 当前用户
   * @param id 资产 id
   * @param dto 编辑输入
   * @returns ok
   */
  async update(operator: AssetOperationLogOperator, userId: number, id: number, dto: AssetUpdateDto, idempotencyKey?: string): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
      scope: 'asset.fixed.update',
      idempotencyKey,
      // 指纹纳入资源 id：同键复用到不同资产时必须按 §9.5 返回冲突而非静默重放
      fingerprint: fingerprintPayload({ ...dto, id }),
      run: async (tx) => {
        const existing = await tx.asset.findUnique({ where: { id } });
        if (!existing || existing.deletedAt !== null) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await this.assertMaintainScope(userId, existing.departmentId);
        // 状态机：待维修/维修中只由维修管理产生和流转，普通编辑不可写入或跳出
        // （DTO 目标状态限定 IDLE/IN_USE：闲置/使用中互切、已报废恢复为闲置/使用中）
        if (existing.usageStatus === 'PENDING_REPAIR' || existing.usageStatus === 'REPAIRING') {
          throw new BusinessException(assetErrors.ASSET_STATUS_INVALID);
        }
        const prepared = await this.prepareSnapshot(tx, dto);
        // A-5 变更记录（只追加；记录前后值与操作人）
        const changes: Array<[string, unknown, unknown]> = [
          ['name', existing.name, prepared.name],
          ['specModel', existing.specModel, prepared.specModel],
          ['amount', existing.amount.toString(), dto.amount],
          ['usageStatus', existing.usageStatus, dto.usageStatus],
          ['currentUserId', existing.currentUserId, dto.currentUserId ?? null],
          ['remark', existing.remark, dto.remark ?? null],
        ];
        const changed = changes.filter(([, before, after]) => String(before ?? '') !== String(after ?? ''));
        await tx.asset.update({
          where: { id },
          data: {
            name: prepared.name,
            categoryId: prepared.categoryId,
            categoryName: prepared.categoryName,
            specModel: prepared.specModel,
            amount: new Prisma.Decimal(dto.amount),
            purchaseAt: prepared.purchaseAt,
            ownership: dto.ownership,
            ownerName: dto.ownerName ?? null,
            currentUserId: dto.currentUserId ?? null,
            currentUserName: prepared.currentUserName,
            imageOssKey: dto.imageOssKey ?? null,
            remark: dto.remark ?? null,
            usageStatus: dto.usageStatus,
            updatedBy: operator.id,
          },
        });
        if (changed.length > 0) {
          const beforeObj: Record<string, unknown> = {};
          const afterObj: Record<string, unknown> = {};
          for (const [field, before, after] of changed) {
            beforeObj[field] = before;
            afterObj[field] = after;
          }
          await tx.assetChange.create({
            data: {
              assetId: id,
              before: beforeObj as Prisma.InputJsonValue,
              after: afterObj as Prisma.InputJsonValue,
              operatorId: operator.id,
              operatorName: operator.name,
            },
          });
        }
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `编辑了固定资产：${prepared.name}`,
        };
      },
    });
  }

  /**
   * 调度（部门与责任人任一变化才允许；目标责任人必须属于目标部门；写调度记录 A-4）。
   *
   * @param operator 操作人
   * @param userId 当前用户
   * @param id 资产 id
   * @param dto 调度输入
   * @returns ok
   */
  async schedule(operator: AssetOperationLogOperator, userId: number, id: number, dto: AssetScheduleDto, idempotencyKey?: string): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
      scope: 'asset.fixed.schedule',
      idempotencyKey,
      fingerprint: fingerprintPayload({ ...dto, id }),
      run: async (tx) => {
        const existing = await tx.asset.findUnique({ where: { id } });
        if (!existing || existing.deletedAt !== null) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 来源部门与目标部门均须在授权闭包内（跨出授权闭包的调度由公司范围维护者执行）
        await this.assertMaintainScope(userId, existing.departmentId);
        await this.assertMaintainScope(userId, dto.toDepartmentId);
        // 部门与责任人均未变化不允许提交
        if (existing.departmentId === dto.toDepartmentId && existing.responsibleUserId === dto.toUserId) {
          throw new BusinessException(assetErrors.ASSET_TRANSFER_NO_CHANGE);
        }
        // 目标责任人必须属于目标部门（hr.user_org 直接归属）
        const belong = await tx.$queryRaw<Array<{ cnt: bigint }>>`
          SELECT COUNT(*) AS cnt
          FROM hr.user_org
          WHERE user_id = ${dto.toUserId} AND department_id = ${dto.toDepartmentId}
        `;
        if (Number(belong[0]?.cnt ?? 0) === 0) {
          throw new BusinessException(assetErrors.ASSIGNEE_DEPARTMENT_MISMATCH);
        }
        const targetDepartment = await tx.$queryRaw<Array<{ name: string }>>`
          SELECT name FROM hr.departments_view WHERE id = ${dto.toDepartmentId} LIMIT 1
        `;
        const targetUser = await tx.$queryRaw<Array<{ name: string }>>`
          SELECT name FROM backstage.user_accounts WHERE user_id = ${dto.toUserId} LIMIT 1
        `;
        // 写调度记录（只追加）+ 更新台账
        await tx.assetTransfer.create({
          data: {
            assetId: id,
            fromDepartmentId: existing.departmentId,
            fromDepartmentName: existing.departmentName,
            toDepartmentId: dto.toDepartmentId,
            toDepartmentName: targetDepartment[0]?.name ?? '',
            fromUserId: existing.responsibleUserId,
            fromUserName: existing.responsibleUserName,
            toUserId: dto.toUserId,
            toUserName: targetUser[0]?.name ?? '',
            operatorId: operator.id,
            operatorName: operator.name,
          },
        });
        await tx.asset.update({
          where: { id },
          data: {
            departmentId: dto.toDepartmentId,
            departmentName: targetDepartment[0]?.name ?? '',
            responsibleUserId: dto.toUserId,
            responsibleUserName: targetUser[0]?.name ?? '',
            updatedBy: operator.id,
          },
        });
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `调度了固定资产 ${existing.name}：责任人 → ${targetUser[0]?.name ?? dto.toUserId}（${targetDepartment[0]?.name ?? ''}）`,
        };
      },
    });
  }

  /**
   * 报废（二次确认；已报废是业务状态非删除；记录 A-5 前后值）。
   *
   * @param operator 操作人
   * @param userId 当前用户
   * @param id 资产 id
   * @param confirm 二次确认标志
   * @returns ok
   */
  async scrap(operator: AssetOperationLogOperator, userId: number, id: number, confirm: boolean, idempotencyKey?: string): Promise<{ ok: true }> {
    if (!confirm) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '需要二次确认' });
    }
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
      scope: 'asset.fixed.scrap',
      idempotencyKey,
      fingerprint: fingerprintPayload({ id }),
      run: async (tx) => {
        const existing = await tx.asset.findUnique({ where: { id } });
        if (!existing || existing.deletedAt !== null) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await this.assertMaintainScope(userId, existing.departmentId);
        if (existing.usageStatus === 'SCRAPPED') {
          throw new BusinessException(assetErrors.ASSET_STATUS_INVALID);
        }
        if (existing.usageStatus === 'PENDING_REPAIR' || existing.usageStatus === 'REPAIRING') {
          throw new BusinessException(assetErrors.ASSET_STATUS_INVALID);
        }
        await tx.asset.update({
          where: { id },
          data: { usageStatus: 'SCRAPPED', updatedBy: operator.id },
        });
        await tx.assetChange.create({
          data: {
            assetId: id,
            before: { usageStatus: existing.usageStatus } as Prisma.InputJsonValue,
            after: { usageStatus: 'SCRAPPED' } as Prisma.InputJsonValue,
            operatorId: operator.id,
            operatorName: operator.name,
          },
        });
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `报废了固定资产：${existing.name}`,
        };
      },
    });
  }

  /**
   * 批量软删除（仍在使用或有业务关联的资产整批拒绝；已报废/无关联可删）。
   *
   * @param operator 操作人
   * @param userId 当前用户
   * @param dto 删除输入
   * @returns 删除结果
   */
  async batchDelete(operator: AssetOperationLogOperator, userId: number, dto: AssetBatchDeleteDto, idempotencyKey?: string): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
      scope: 'asset.fixed.delete',
      idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        const rows = await tx.asset.findMany({ where: { id: { in: dto.ids }, deletedAt: null } });
        if (rows.length !== dto.ids.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 部门范围维护者：资产须在其闭包内
        for (const row of rows) {
          await this.assertMaintainScope(userId, row.departmentId);
        }
        // 业务关联检查：仍在使用（IN_USE）或存在进行中维修单 → 整批拒绝（asset PRD §4）
        const ids = dto.ids;
        const [inUse, activeRepairs] = await Promise.all([
          tx.asset.count({ where: { id: { in: ids }, deletedAt: null, usageStatus: 'IN_USE' } }),
          tx.$queryRaw<Array<{ total: bigint }>>`
            SELECT COUNT(*) AS total
            FROM asset.repair_orders
            WHERE asset_id = ANY(${ids as number[]})
              AND status IN ('PENDING', 'REPAIRING')
          `,
        ]);
        const referenced = inUse + Number(activeRepairs[0]?.total ?? 0);
        if (referenced > 0) {
          throw new BusinessException(assetErrors.ASSET_REFERENCED, { referenced });
        }
        const result = await tx.asset.updateMany({
          where: { id: { in: ids }, deletedAt: null },
          data: { deletedBy: operator.id, deletedAt: new Date(), updatedBy: operator.id },
        });
        return {
          result: { deleted: result.count },
          actionType: 'DELETE' as const,
          summary: `删除了 ${result.count} 条固定资产台账`,
        };
      },
    });
  }

  /** 分页查询并格式化为详情行 */
  private async paginate(
    where: Prisma.AssetWhereInput,
    page: number,
    pageSize: number,
    orderBy?: Prisma.AssetOrderByWithRelationInput[],
  ): Promise<{ items: AssetDetail[]; total: number }> {
    const [total, rows] = await Promise.all([
      this.prisma.client.asset.count({ where }),
      this.prisma.client.asset.findMany({
        where,
        orderBy: orderBy ?? [{ id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((row) => ({
        ...row,
        amount: row.amount.toFixed(2),
      })),
    };
  }

  /** 详情可见性断言（我的资产 / 固定资产查看 / 维护任一） */
  private async assertViewAccess(
    userId: number,
    asset: { responsibleUserId: number | null; currentUserId: number | null; departmentId: number | null },
  ): Promise<void> {
    for (const functionCode of [MY_ASSETS_FUNCTION_CODE, FIXED_ASSET_VIEW_FUNCTION_CODE, FIXED_ASSET_MAINTAIN_FUNCTION_CODE]) {
      const access = await getFunctionAccess(this.prisma.client, userId, functionCode);
      if (!access.registered || !access.systemOpen || !access.allowed) {
        continue;
      }
      if (functionCode === MY_ASSETS_FUNCTION_CODE) {
        if (asset.responsibleUserId === userId || asset.currentUserId === userId) {
          return;
        }
        continue;
      }
      if (access.dataScope === null || access.dataScope === 'COMPANY') {
        return;
      }
      if (asset.departmentId !== null) {
        const closure = await this.closures.closureOfUser(userId);
        if (closure.has(asset.departmentId)) {
          return;
        }
      }
    }
    throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
  }

  /** 维护范围断言：目标部门（可为空）在授权闭包内 */
  private async assertMaintainScope(userId: number, departmentId: number | null | undefined): Promise<void> {
    const access = await getFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    if (!access.registered || !access.systemOpen || !access.allowed) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    if (access.dataScope === null || access.dataScope === 'COMPANY') {
      return;
    }
    if (departmentId === null || departmentId === undefined) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const closure = await this.closures.closureOfUser(userId);
    if (!closure.has(departmentId)) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
  }

  /** 建档/编辑快照准备（分类名称/部门名称/用户姓名快照；金额在调用方转换） */
  private async prepareSnapshot(
    tx: Prisma.TransactionClient,
    dto: AssetCreateDto | AssetUpdateDto,
  ): Promise<{
    name: string;
    categoryId: number | null;
    categoryName: string | null;
    specModel: string | null;
    purchaseAt: Date | null;
    departmentId: number | null;
    departmentName: string | null;
    responsibleUserName: string | null;
    currentUserName: string | null;
  }> {
    let categoryName: string | null = null;
    if (dto.categoryId !== undefined) {
      // 固定资产只能归入固定资产顶级分类（与消耗品侧校验对称，asset PRD §3）
      const rows = await tx.$queryRaw<Array<{ name: string; topName: string }>>`
        SELECT c.name, COALESCE(p.name, c.name) AS "topName"
        FROM asset.asset_categories c
        LEFT JOIN asset.asset_categories p ON p.id = c.parent_id
        WHERE c.id = ${dto.categoryId}
        LIMIT 1
      `;
      const category = rows[0];
      if (!category) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '分类不存在' });
      }
      if (category.topName !== '固定资产') {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '固定资产只能归入固定资产分类' });
      }
      categoryName = category.name;
    }
    let departmentName: string | null = null;
    // AssetUpdateDto 不允许部门变化（走调度）；仅建档携带 departmentId
    if ('departmentId' in dto && dto.departmentId !== undefined) {
      const rows = await tx.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM hr.departments_view WHERE id = ${dto.departmentId} LIMIT 1
      `;
      departmentName = rows[0]?.name ?? '';
    }
    const userName = async (userId: number | undefined): Promise<string | null> => {
      if (userId === undefined) {
        return null;
      }
      const rows = await tx.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM backstage.user_accounts WHERE user_id = ${userId} LIMIT 1
      `;
      return rows[0]?.name ?? '';
    };
    const purchaseAt = dto.purchaseAt ? toDbDate(dto.purchaseAt) : null;
    return {
      name: dto.name,
      categoryId: dto.categoryId ?? null,
      categoryName,
      specModel: dto.specModel ?? null,
      purchaseAt,
      departmentId: 'departmentId' in dto ? (dto.departmentId ?? null) : null,
      departmentName,
      responsibleUserName: 'responsibleUserId' in dto ? await userName(dto.responsibleUserId) : null,
      currentUserName: await userName(dto.currentUserId),
    };
  }
}

/** YYYY-MM-DD → Date（@db.Date 日历值，Date.UTC 构造避免时区偏移） */
function toDbDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}
