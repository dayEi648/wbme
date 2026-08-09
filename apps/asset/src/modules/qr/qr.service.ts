import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  CONSUMABLE_APPLY_FUNCTION_CODE,
  FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
  FIXED_ASSET_VIEW_FUNCTION_CODE,
  INVENTORY_MANAGE_FUNCTION_CODE,
  MY_ASSETS_FUNCTION_CODE,
  QrCodeCreateDto,
  QrCodeQueryDto,
  assetErrors,
  frameworkErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { getFunctionAccess } from '../../shared/cross-schema-auth';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';

/**
 * 二维码服务（asset PRD §11；A-27）。
 *
 * - 公开标识为独立、至少 128 位随机性的不透明标识（256 bit），不编码数据库自增 ID
 *   或业务编号；数据库保存公开标识原值（唯一索引）与目标类型/目标标识；
 * - 标识不是登录凭证或授权秘密：扫码后仍由服务端解析并执行登录、权限和状态校验，
 *   二维码本身不授予任何权限；解析接口限流，日志不记录完整扫码 URL；
 * - 三种管理动作：停用 / 恢复 / 作废并重新生成（REVOKED 终态不可恢复；重新生成
 *   创建新随机标识并使旧标识永久失效）；同一目标同时最多一张未作废二维码；
 * - 解析成功后仍按当前登录用户的功能权限、数据范围、目标状态和库存状态校验；
 *   无权限/目标已删除/二维码无效/条目不可申领时不泄露目标内部详情。
 */
@Injectable()
export class QrService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly closures: DepartmentClosureService,
  ) {}

  /**
   * 创建二维码（幂等；目标类型决定归属权限——ASSET 归固定资产维护，其余归库存管理）。
   *
   * @param operator 操作人
   * @param dto 创建输入
   * @returns 二维码 id + 公开标识
   */
  async create(operator: AssetOperationLogOperator, dto: QrCodeCreateDto): Promise<{ id: number; publicId: string }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: dto.targetType === 'ASSET' ? FIXED_ASSET_MAINTAIN_FUNCTION_CODE : INVENTORY_MANAGE_FUNCTION_CODE,
      scope: 'asset.qr.create',
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        // 目标存在性校验（SCAN_CATALOG 无目标）
        if (dto.targetType === 'ASSET') {
          const asset = await tx.asset.findFirst({ where: { id: dto.targetId ?? -1, deletedAt: null } });
          if (!asset) {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
        } else if (dto.targetType === 'INVENTORY_ITEM') {
          const item = await tx.inventoryItem.findUnique({ where: { id: dto.targetId ?? -1 } });
          if (!item) {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
        }
        // 同一目标同时最多一张未作废二维码（部分唯一索引兜底）
        const publicId = randomBytes(32).toString('base64url');
        try {
          const row = await tx.qrCode.create({
            data: {
              publicId,
              targetType: dto.targetType,
              targetId: dto.targetType === 'SCAN_CATALOG' ? null : (dto.targetId ?? null),
              createdBy: operator.id,
            },
          });
          return {
            result: { id: row.id, publicId: row.publicId },
            actionType: 'CREATE' as const,
            summary: `生成了二维码（${dto.targetType}${dto.targetId ? ` #${dto.targetId}` : ''}）`,
          };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '该目标已存在有效二维码，请先作废' });
          }
          throw error;
        }
      },
    });
  }

  /**
   * 二维码列表（分页；目标类型/状态筛选；仅可见用户拥有管理权限的目标类型）。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @param allowedTargetTypes 用户可见的目标类型（按管理权限过滤后的白名单）
   * @returns items + total
   */
  async list(userId: number, query: QrCodeQueryDto, allowedTargetTypes: Array<'ASSET' | 'INVENTORY_ITEM' | 'SCAN_CATALOG'>): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.QrCodeWhereInput = { targetType: { in: allowedTargetTypes } };
    if (query.targetType) {
      where.targetType = query.targetType;
    }
    if (query.status) {
      where.status = query.status;
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.qrCode.count({ where }),
      this.prisma.client.qrCode.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /**
   * 二维码管理动作（停用 / 恢复 / 作废并重新生成；REVOKED 终态不可操作）。
   *
   * @param operator 操作人
   * @param id 二维码 id
   * @param action 动作
   * @returns 新二维码（REGENERATE 时）
   */
  async action(
    operator: AssetOperationLogOperator,
    id: number,
    action: 'DISABLE' | 'ENABLE' | 'REGENERATE',
  ): Promise<{ ok: true; regenerated?: { id: number; publicId: string } }> {
    // 按目标类型校验管理权限（资产二维码归固定资产维护，库存/目录二维码归
    // 消耗品库存管理，PRD §11 归属）；权限不足 → 404 不泄露存在性
    const qrForScope = await this.prisma.client.qrCode.findUnique({ where: { id }, select: { targetType: true } });
    if (!qrForScope) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const requiredCode = qrForScope.targetType === 'ASSET' ? FIXED_ASSET_MAINTAIN_FUNCTION_CODE : INVENTORY_MANAGE_FUNCTION_CODE;
    const access = await getFunctionAccess(this.prisma.client, operator.id, requiredCode);
    if (!access.registered || !access.allowed) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    return executeIdempotentOperation<{ ok: true; regenerated?: { id: number; publicId: string } }>(this.prisma.client, {
      operator,
      feature: requiredCode,
      scope: 'asset.qr.action',
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload({ id, action }),
      run: async (tx) => {
        const qr = await tx.qrCode.findUnique({ where: { id } });
        if (!qr) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (qr.status === 'REVOKED') {
          throw new BusinessException(assetErrors.QR_REVOKED);
        }
        if (action === 'REGENERATE') {
          // 作废旧标识（永久失效）+ 创建新标识（同目标唯一索引）
          const publicId = randomBytes(32).toString('base64url');
          await tx.qrCode.update({
            where: { id },
            data: { status: 'REVOKED', revokedAt: new Date(), updatedBy: operator.id },
          });
          const row = await tx.qrCode.create({
            data: {
              publicId,
              targetType: qr.targetType,
              targetId: qr.targetId,
              createdBy: operator.id,
            },
          });
          return {
            result: { ok: true, regenerated: { id: row.id, publicId: row.publicId } },
            actionType: 'UPDATE' as const,
            summary: `作废并重新生成了二维码（${qr.targetType}${qr.targetId ? ` #${qr.targetId}` : ''}）`,
          };
        }
        await tx.qrCode.update({
          where: { id },
          data: { status: action === 'DISABLE' ? 'DISABLED' : 'ACTIVE', updatedBy: operator.id },
        });
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `${action === 'DISABLE' ? '停用' : '恢复'}了二维码（${qr.targetType}${qr.targetId ? ` #${qr.targetId}` : ''}）`,
        };
      },
    });
  }

  /**
   * 扫码解析（接口限流；解析后执行登录、权限与状态校验；失败不泄露目标内部详情）。
   *
   * @param userId 当前登录用户
   * @param publicId 公开标识（来自 /scan#<publicId>；服务端不写完整标识到日志）
   * @returns 目标入口信息；无权限/目标不可用时与二维码无效同样返回 404
   */
  async parse(userId: number, publicId: string): Promise<{
    targetType: string;
    targetId: number | null;
    entry: { type: string; asset?: { id: number; name: string } | null; item?: { id: number; consumableName: string; spec: string; warehouseName: string } | null };
  }> {
    const qr = await this.prisma.client.qrCode.findUnique({ where: { publicId } });
    if (!qr || qr.status !== 'ACTIVE') {
      throw new BusinessException(assetErrors.QR_INVALID);
    }
    if (qr.targetType === 'ASSET') {
      // 资产扫码查看入口：需「我的资产 / 固定资产查看 / 固定资产维护」任一可见
      const asset = await this.prisma.client.asset.findFirst({ where: { id: qr.targetId ?? -1, deletedAt: null } });
      if (!asset) {
        throw new BusinessException(assetErrors.QR_INVALID);
      }
      const canView = await this.canViewAsset(userId, asset);
      if (!canView) {
        throw new BusinessException(assetErrors.QR_INVALID);
      }
      return {
        targetType: 'ASSET',
        targetId: asset.id,
        entry: { type: 'asset', asset: { id: asset.id, name: asset.name } },
      };
    }
    if (qr.targetType === 'INVENTORY_ITEM') {
      // 库存条目扫码申领入口：须持有「消耗品申领」权限（无权限不泄露目标内部详情）
      const applyAccess = await getFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPLY_FUNCTION_CODE);
      if (!applyAccess.registered || !applyAccess.systemOpen || !applyAccess.allowed) {
        throw new BusinessException(assetErrors.QR_INVALID);
      }
      // 目标必须当前可申领（品种启用且有可用库存）
      const rows = await this.prisma.client.$queryRaw<
        Array<{ id: number; consumable_name: string; spec: string; warehouse_name: string; available: bigint }>
      >`
        SELECT ii.id, c.name AS consumable_name, ii.spec, ii.warehouse_name,
               (ii.book_qty - ii.reserved_qty) AS available
        FROM asset.inventory_items ii
        INNER JOIN asset.consumables c ON c.id = ii.consumable_id
        WHERE ii.id = ${qr.targetId ?? -1}
          AND c.status = 'ACTIVE'
          AND (ii.book_qty - ii.reserved_qty) > 0
        LIMIT 1
      `;
      const item = rows[0];
      if (!item) {
        throw new BusinessException(assetErrors.QR_INVALID);
      }
      return {
        targetType: 'INVENTORY_ITEM',
        targetId: item.id,
        entry: { type: 'inventory-item', item: { id: item.id, consumableName: item.consumable_name, spec: item.spec, warehouseName: item.warehouse_name } },
      };
    }
    // SCAN_CATALOG：长期有效申领目录入口
    return { targetType: 'SCAN_CATALOG', targetId: null, entry: { type: 'scan-catalog' } };
  }

  /** 资产可见性：我的资产（本人）/ 固定资产查看 / 固定资产维护（数据范围）任一 */
  private async canViewAsset(
    userId: number,
    asset: { id: number; responsibleUserId: number | null; currentUserId: number | null; departmentId: number | null },
  ): Promise<boolean> {
    for (const functionCode of [MY_ASSETS_FUNCTION_CODE, FIXED_ASSET_VIEW_FUNCTION_CODE, FIXED_ASSET_MAINTAIN_FUNCTION_CODE]) {
      const access = await getFunctionAccess(this.prisma.client, userId, functionCode);
      if (!access.registered || !access.systemOpen || !access.allowed) {
        continue;
      }
      if (functionCode === MY_ASSETS_FUNCTION_CODE) {
        if (asset.responsibleUserId === userId || asset.currentUserId === userId) {
          return true;
        }
        continue;
      }
      if (access.dataScope === null || access.dataScope === 'COMPANY') {
        return true;
      }
      // DEPARTMENT：资产所属部门须在授权闭包内
      if (asset.departmentId === null) {
        continue;
      }
      const closure = await this.closures.closureOfUser(userId);
      if (closure.has(asset.departmentId)) {
        return true;
      }
    }
    return false;
  }
}
