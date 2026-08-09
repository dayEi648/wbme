import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
  RepairCompleteDto,
  RepairOrderCreateDto,
  RepairOrderQueryDto,
  assetErrors,
  frameworkErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { getFunctionAccess, type FunctionAccess } from '../../shared/cross-schema-auth';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';

/** 维修单状态（与 asset 模块 Prisma enum 对齐） */
type RepairStatus = 'PENDING' | 'REPAIRING' | 'CANCELLED' | 'COMPLETED';

/** 维修状态流转动作（与 asset 模块 Prisma enum 对齐） */
type RepairAction = 'REGISTER' | 'CANCEL' | 'START' | 'COMPLETE';

/** 状态 + 版本条件更新的期望/目标映射 */
const TRANSITIONS: Readonly<
  Record<Exclude<RepairAction, 'REGISTER'>, { from: RepairStatus; to: RepairStatus; assetStatus: 'PENDING_REPAIR' | 'REPAIRING' | 'IDLE' | 'IN_USE' | null }>
> = {
  CANCEL: { from: 'PENDING', to: 'CANCELLED', assetStatus: null }, // 恢复 pre_status
  START: { from: 'PENDING', to: 'REPAIRING', assetStatus: 'REPAIRING' },
  COMPLETE: { from: 'REPAIRING', to: 'COMPLETED', assetStatus: null }, // 恢复 post_status
};

/**
 * 固定资产维修管理服务（asset PRD §4；A-6/A-7）。
 *
 * - 只有当前为「闲置/使用中」的资产可以登记维修；登记时保存进入维修前的状态快照
 *   （pre_status）并把资产改为「待维修」；
 * - 待维修可「取消登记」→ 已取消终态（只读）并把资产恢复为登记前状态，不删除该单；
 *   维修中不能取消，只能完成；开始维修把资产转「维修中」；维修完成填写结果/实际
 *   费用/完成时间并选择恢复为「使用中/闲置」（耗时 = 开始与完成时间自动计算）；
 * - 同一资产同一时刻最多一张进行中维修单（事务内校验 + 条件唯一索引共同保证）；
 * - 登记/取消/开始/完成均在事务内使用当前状态与版本号条件更新，并发重复操作
 *   只有一个成功；维修单及状态流转历史只追加，不因资产之后报废/恢复/删除而改写。
 */
@Injectable()
export class RepairService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly closures: DepartmentClosureService,
  ) {}

  /**
   * 登记维修（幂等；仅闲置/使用中资产；同一资产最多一张进行中维修单）。
   *
   * @param operator 操作人
   * @param userId 当前用户
   * @param dto 登记输入
   * @returns 维修单 id
   */
  async register(operator: AssetOperationLogOperator, userId: number, dto: RepairOrderCreateDto): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
      scope: 'asset.repair.register',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        const asset = await tx.asset.findUnique({ where: { id: dto.assetId } });
        if (!asset || asset.deletedAt !== null) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await this.assertMaintainScope(userId, asset.departmentId);
        if (asset.usageStatus !== 'IDLE' && asset.usageStatus !== 'IN_USE') {
          throw new BusinessException(assetErrors.ASSET_STATUS_INVALID);
        }
        // 资产 → 待维修（条件更新；并发仅一个成功）
        const updated = await tx.asset.updateMany({
          where: { id: dto.assetId, usageStatus: asset.usageStatus },
          data: { usageStatus: 'PENDING_REPAIR', updatedBy: operator.id },
        });
        if (updated.count === 0) {
          throw new BusinessException(assetErrors.ASSET_STATUS_INVALID);
        }
        try {
          const order = await tx.repairOrder.create({
            data: {
              assetId: dto.assetId,
              faultDescription: dto.faultDescription,
              reportedAt: dto.reportedAt ? new Date(dto.reportedAt) : new Date(),
              preStatus: asset.usageStatus,
              createdBy: operator.id,
            },
          });
          await tx.repairOrderAction.create({
            data: {
              orderId: order.id,
              action: 'REGISTER',
              fromStatus: 'PENDING',
              toStatus: 'PENDING',
              operatorId: operator.id,
              operatorName: operator.name,
            },
          });
          return {
            result: { id: order.id },
            actionType: 'CREATE' as const,
            summary: `登记了资产维修：${asset.name}（${dto.faultDescription.slice(0, 20)}）`,
          };
        } catch (error) {
          // 并发登记撞条件唯一索引（同一资产进行中维修单）
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(assetErrors.MAINTENANCE_ACTIVE_EXISTS);
          }
          throw error;
        }
      },
    });
  }

  /**
   * 取消登记（待维修 → 已取消终态；资产恢复为登记前状态；不删除该单）。
   *
   * @param operator 操作人
   * @param userId 当前用户
   * @param id 维修单 id
   * @returns ok
   */
  async cancel(operator: AssetOperationLogOperator, userId: number, id: number): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
      scope: 'asset.repair.cancel',
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload({ id }),
      run: async (tx) => {
        const order = await tx.repairOrder.findUnique({ where: { id } });
        if (!order) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const asset = await tx.asset.findUnique({ where: { id: order.assetId } });
        if (!asset || asset.deletedAt !== null) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await this.assertMaintainScope(userId, asset.departmentId);
        const transition = TRANSITIONS.CANCEL;
        // 维修单状态 + 版本条件更新（并发只有一个成功）
        const updated = await tx.repairOrder.updateMany({
          where: { id, status: transition.from, version: order.version },
          data: { status: transition.to, version: { increment: 1 }, updatedBy: operator.id },
        });
        if (updated.count === 0) {
          throw new BusinessException(assetErrors.ASSET_STATUS_INVALID);
        }
        // 资产恢复为登记前状态（待维修只能由本单取消解除）
        await tx.asset.update({ where: { id: order.assetId }, data: { usageStatus: order.preStatus, updatedBy: operator.id } });
        await tx.repairOrderAction.create({
          data: {
            orderId: id,
            action: 'CANCEL',
            fromStatus: 'PENDING',
            toStatus: 'CANCELLED',
            operatorId: operator.id,
            operatorName: operator.name,
          },
        });
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `取消了维修登记（单号 ${id}）`,
        };
      },
    });
  }

  /**
   * 开始维修（待维修 → 维修中；记录开始时间；资产转维修中）。
   *
   * @param operator 操作人
   * @param userId 当前用户
   * @param id 维修单 id
   * @param startedAt 开始时间（缺省当前）
   * @returns ok
   */
  async start(operator: AssetOperationLogOperator, userId: number, id: number, startedAt?: string): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
      scope: 'asset.repair.start',
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload({ id, startedAt }),
      run: async (tx) => {
        const order = await tx.repairOrder.findUnique({ where: { id } });
        if (!order) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const asset = await tx.asset.findUnique({ where: { id: order.assetId } });
        if (!asset || asset.deletedAt !== null) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await this.assertMaintainScope(userId, asset.departmentId);
        const transition = TRANSITIONS.START;
        const now = startedAt ? new Date(startedAt) : new Date();
        const updated = await tx.repairOrder.updateMany({
          where: { id, status: transition.from, version: order.version },
          data: { status: transition.to, version: { increment: 1 }, startedAt: now, updatedBy: operator.id },
        });
        if (updated.count === 0) {
          throw new BusinessException(assetErrors.ASSET_STATUS_INVALID);
        }
        await tx.asset.update({
          where: { id: order.assetId },
          data: { usageStatus: 'REPAIRING', updatedBy: operator.id },
        });
        await tx.repairOrderAction.create({
          data: {
            orderId: id,
            action: 'START',
            fromStatus: 'PENDING',
            toStatus: 'REPAIRING',
            operatorId: operator.id,
            operatorName: operator.name,
          },
        });
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `开始维修（单号 ${id}）`,
        };
      },
    });
  }

  /**
   * 维修完成（维修中 → 已完成；填写结果/实际费用/完成时间；耗时自动计算；
   * 资产恢复为所选状态）。
   *
   * @param operator 操作人
   * @param userId 当前用户
   * @param id 维修单 id
   * @param dto 完成输入
   * @returns ok
   */
  async complete(operator: AssetOperationLogOperator, userId: number, id: number, dto: RepairCompleteDto): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
      scope: 'asset.repair.complete',
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        const order = await tx.repairOrder.findUnique({ where: { id } });
        if (!order) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const asset = await tx.asset.findUnique({ where: { id: order.assetId } });
        if (!asset || asset.deletedAt !== null) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await this.assertMaintainScope(userId, asset.departmentId);
        const transition = TRANSITIONS.COMPLETE;
        const completedAt = dto.completedAt ? new Date(dto.completedAt) : new Date();
        const updated = await tx.repairOrder.updateMany({
          where: { id, status: transition.from, version: order.version },
          data: {
            status: transition.to,
            version: { increment: 1 },
            completedAt,
            result: dto.result,
            actualCost: new Prisma.Decimal(dto.actualCost),
            postStatus: dto.postStatus,
            updatedBy: operator.id,
          },
        });
        if (updated.count === 0) {
          throw new BusinessException(assetErrors.ASSET_STATUS_INVALID);
        }
        await tx.asset.update({
          where: { id: order.assetId },
          data: { usageStatus: dto.postStatus, updatedBy: operator.id },
        });
        await tx.repairOrderAction.create({
          data: {
            orderId: id,
            action: 'COMPLETE',
            fromStatus: 'REPAIRING',
            toStatus: 'COMPLETED',
            operatorId: operator.id,
            operatorName: operator.name,
          },
        });
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `完成维修（单号 ${id}，费用 ${dto.actualCost} 元）`,
        };
      },
    });
  }

  /**
   * 维修单列表（按资产/状态筛选）。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @returns items + total
   */
  async list(userId: number, query: RepairOrderQueryDto): Promise<{ items: unknown[]; total: number }> {
    const access = await this.requireMaintainAccess(userId);
    const where: Prisma.RepairOrderWhereInput = {};
    // DEPARTMENT 档：按资产所属部门闭包裁剪（M8 修复：与台账列表一致，防闭包外维修单泄露）
    if (access.dataScope !== null && access.dataScope !== 'COMPANY') {
      const closure = await this.closures.closureOfUser(userId);
      where.asset = { departmentId: { in: [...closure] } };
    }
    if (query.assetId) {
      where.assetId = query.assetId;
    }
    if (query.status) {
      where.status = query.status;
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.repairOrder.count({ where }),
      this.prisma.client.repairOrder.findMany({
        where,
        include: { asset: { select: { name: true, usageStatus: true, departmentId: true, departmentName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((row) => ({
        ...row,
        actualCost: row.actualCost !== null ? row.actualCost.toFixed(2) : null,
        // 耗时 = 开始时间与完成时间之差（分钟；仅已完成单，asset PRD §4 自动计算）
        durationMinutes: computeDurationMinutes(row.startedAt, row.completedAt),
      })),
    };
  }

  /**
   * 维修单详情（含状态流转历史）。
   *
   * @param userId 当前用户
   * @param id 维修单 id
   * @returns 详情
   */
  async detail(userId: number, id: number): Promise<unknown> {
    const access = await this.requireMaintainAccess(userId);
    const order = await this.prisma.client.repairOrder.findUnique({
      where: { id },
      include: {
        actions: { orderBy: { createdAt: 'asc' } },
        asset: { select: { id: true, name: true, usageStatus: true, departmentId: true, departmentName: true } },
      },
    });
    if (!order) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    // DEPARTMENT 档：资产部门须在授权闭包内（M8 修复：与列表裁剪一致）
    if (access.dataScope !== null && access.dataScope !== 'COMPANY') {
      const closure = await this.closures.closureOfUser(userId);
      if (order.asset.departmentId === null || !closure.has(order.asset.departmentId)) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
    }
    return {
      ...order,
      actualCost: order.actualCost !== null ? order.actualCost.toFixed(2) : null,
      // 耗时 = 开始时间与完成时间之差（分钟；仅已完成单，asset PRD §4 自动计算）
      durationMinutes: computeDurationMinutes(order.startedAt, order.completedAt),
    };
  }

  /** 维护授权断言（未注册/未授权 → 404） */
  private async assertMaintainAccess(userId: number): Promise<void> {
    await this.requireMaintainAccess(userId);
  }

  /** 维护授权（未注册/未授权 → 404；返回 access 供数据范围裁剪） */
  private async requireMaintainAccess(userId: number): Promise<FunctionAccess> {
    const access = await getFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    if (!access.registered || !access.systemOpen || !access.allowed) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    return access;
  }

  /** 维护范围断言：资产部门在授权闭包内 */
  private async assertMaintainScope(userId: number, departmentId: number | null): Promise<void> {
    const access = await getFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    if (!access.registered || !access.systemOpen || !access.allowed) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    if (access.dataScope === null || access.dataScope === 'COMPANY') {
      return;
    }
    if (departmentId === null) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const closure = await this.closures.closureOfUser(userId);
    if (!closure.has(departmentId)) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
  }
}

/** 维修耗时（分钟）= 完成时间 − 开始时间；任一时点缺失（未完成/历史单）返回 null */
function computeDurationMinutes(startedAt: Date | null, completedAt: Date | null): number | null {
  if (startedAt === null || completedAt === null || completedAt.getTime() < startedAt.getTime()) {
    return null;
  }
  return Math.round((completedAt.getTime() - startedAt.getTime()) / 60_000);
}
