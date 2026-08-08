import { Inject, Injectable } from '@nestjs/common';
import {
  accountErrors,
  BusinessException,
  frameworkErrors,
  maskPhone,
  permissionErrors,
  USER_MANAGE_FUNCTION_CODE,
} from '@wbme/contracts';
import { SessionService } from '@wbme/server';
import type { IdempotentDto } from '@wbme/contracts';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../permission/operation-log.util';

/**
 * 超级管理员任免服务（主 PRD §3.1「角色与委派」、backstage PRD §3；实现规划 T3-6）。
 *
 * - 仅超级管理员可操作（不拆成可委派功能；站点角色变更不参与功能授权）；
 *   事务内复核操作人当前仍是可用超管、目标账号状态与最后超管约束；
 * - 任命：仅正常（ACTIVE）普通员工可被任命——待激活账号激活后即为普通员工，
 *   再由超管任命（待激活不具备任何平台行为能力，提前任命无意义且易误授）；
 * - 降级/卸任：可对自己或其他超管操作；唯一限制是最后一名可用超管不可卸任/降级——
 *   并发卸任以「锁定全部可用超管行」串行化，锁定集内重新计数，仅一个成功；
 * - 提权旋转（base PRD §3）：任命超管 = 站点角色提升，提交后标记目标会话旋转
 *   （SessionService.markElevation）；降级不是提权，不旋转——降级即时生效由守卫
 *   每次请求实时读取站点角色与授权保证；
 * - 变更前后值写入操作日志（feature=user_manage，入口挂在用户管理页）。
 */
@Injectable()
export class SuperAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly session: SessionService,
  ) {}

  /** 操作日志幂等作用域 */
  private static readonly SCOPE = {
    APPOINT: 'users.super-admin.appoint',
    DEMOTE: 'users.super-admin.demote',
  } as const;

  /**
   * 任命普通员工为超级管理员。
   *
   * @param operatorId 操作人 id（必须是当前可用超管）
   * @param targetUserId 目标员工 id
   * @param dto 可选幂等键
   * @returns ok（重放返回首次结果）
   * @throws FORBIDDEN 操作人不是超管；RESOURCE_NOT_FOUND 目标不存在；
   *         ACCOUNT_DEACTIVATED 目标已注销；USER_NOT_ACTIVE 目标非 ACTIVE（含待激活）；
   *         ALREADY_SUPER_ADMIN 目标已是超管
   */
  async appoint(operatorId: number, targetUserId: number, dto: IdempotentDto): Promise<{ ok: true }> {
    const operator = await this.loadSuperOperator(operatorId);
    const fingerprint = fingerprintPayload({ targetUserId });
    // 提权标记：目标新成为超管时置位（事务提交后标记会话旋转；重放不进入 run，不重复标记）
    let elevated = false;
    const result = await executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: USER_MANAGE_FUNCTION_CODE,
      scope: SuperAdminService.SCOPE.APPOINT,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        await this.assertOperatorStillSuper(tx, operatorId);
        const target = await tx.user.findUnique({ where: { id: targetUserId } });
        if (!target) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (target.status === 'DEACTIVATED' || target.deletedAt !== null) {
          throw new BusinessException(accountErrors.ACCOUNT_DEACTIVATED);
        }
        if (target.status !== 'ACTIVE') {
          throw new BusinessException(accountErrors.USER_NOT_ACTIVE);
        }
        if (target.isSuperAdmin) {
          throw new BusinessException(permissionErrors.ALREADY_SUPER_ADMIN);
        }
        await tx.user.update({
          where: { id: target.id },
          data: { isSuperAdmin: true, permissionVersion: { increment: 1 }, updatedBy: operator.id },
        });
        elevated = true;
        return {
          result: { ok: true as const },
          actionType: 'UPDATE',
          summary: `任命超级管理员：${target.name}（${maskPhone(target.phone)}）：站点角色 员工 → 超级管理员`,
        };
      },
    });
    if (elevated) {
      await this.session.markElevation(targetUserId);
    }
    return result;
  }

  /**
   * 把超级管理员降级为普通员工（可对自己操作）。
   *
   * @param operatorId 操作人 id（必须是当前可用超管）
   * @param targetUserId 目标超管 id
   * @param dto 可选幂等键
   * @returns ok（重放返回首次结果）
   * @throws FORBIDDEN 操作人不是可用超管；NOT_SUPER_ADMIN 目标不是超管；
   *         LAST_SUPER_ADMIN 目标为最后一名可用超管（含并发卸任仅一个成功）
   */
  async demote(operatorId: number, targetUserId: number, dto: IdempotentDto): Promise<{ ok: true }> {
    const operator = await this.loadSuperOperator(operatorId);
    const fingerprint = fingerprintPayload({ targetUserId });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: USER_MANAGE_FUNCTION_CODE,
      scope: SuperAdminService.SCOPE.DEMOTE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 锁定全部可用超管行：并发卸任串行化，锁定集内重新计数（最后一名超管保护的并发正确性）
        const activeSupers = await tx.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM base.users
          WHERE is_super_admin AND status = 'ACTIVE' AND deleted_at IS NULL
          ORDER BY id FOR UPDATE
        `;
        // 事务内复核操作人当前仍是可用超管（主 PRD §3.1）
        if (!activeSupers.some((row) => row.id === operatorId)) {
          throw new BusinessException(frameworkErrors.FORBIDDEN);
        }
        const target = await tx.user.findUnique({ where: { id: targetUserId } });
        if (!target || target.deletedAt !== null) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (!target.isSuperAdmin) {
          throw new BusinessException(permissionErrors.NOT_SUPER_ADMIN);
        }
        // 最后一名可用超管不可卸任/降级（可用 = ACTIVE 且未注销）
        if (target.status === 'ACTIVE' && activeSupers.length <= 1) {
          throw new BusinessException(permissionErrors.LAST_SUPER_ADMIN);
        }
        await tx.user.update({
          where: { id: target.id },
          data: { isSuperAdmin: false, permissionVersion: { increment: 1 }, updatedBy: operator.id },
        });
        return {
          result: { ok: true as const },
          actionType: 'UPDATE',
          summary: `超级管理员降级：${target.name}（${maskPhone(target.phone)}）：站点角色 超级管理员 → 员工`,
        };
      },
    });
  }

  /**
   * 加载并校验操作人为超管（服务层强制；站点角色变更不拆可委派功能）。
   * 事务内再由 assertOperatorStillSuper 复核。
   *
   * @throws FORBIDDEN 操作人不是超管
   */
  private async loadSuperOperator(operatorId: number) {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    if (!operator.isSuperAdmin) {
      throw new BusinessException(frameworkErrors.FORBIDDEN);
    }
    return operator;
  }

  /** 事务内复核操作人当前仍是超管（主 PRD §3.1：提交前复核当前角色） */
  private async assertOperatorStillSuper(tx: Prisma.TransactionClient, operatorId: number): Promise<void> {
    const operator = await tx.user.findUnique({
      where: { id: operatorId },
      select: { isSuperAdmin: true, deletedAt: true },
    });
    if (!operator || operator.deletedAt !== null || !operator.isSuperAdmin) {
      throw new BusinessException(frameworkErrors.FORBIDDEN);
    }
  }
}
