import { Inject, Injectable } from '@nestjs/common';
import { isPrismaUniqueViolation } from '@wbme/approval';
import { BusinessException, hrErrors, type HrRestoreApplyDto, type HrRestorePreviewDto } from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { loadUserName } from '../../shared/cross-schema-auth';
import { bumpUserOrgVersion } from '../../shared/org-version.service';

/** 恢复预览目标项 */
export interface RestorePreviewTarget {
  userId: number;
  restorable: boolean;
  blockedReasonCode?: string;
  removedDepartmentNames?: string[];
  positionCleared?: boolean;
}

/** 单目标兼容性检查结果（preview 与 apply 共用） */
interface CompatibilityCheck {
  /** 停用部门（待清除；应用时删除 user_departments 关系） */
  clearedDepartments: Array<{ id: number; name: string }>;
  /** 岗位是否置空（岗位不存在或不再适用于全部保留部门） */
  positionCleared: boolean;
}

/**
 * 账号生命周期服务（backstage PRD §3 / hr PRD §5）：
 * - restore-preview：只读兼容性检查（不写数据）；
 * - restore-apply：单事务整批应用组织兼容性清理 + 幂等取消注销前待审批岗位申请；
 *   以 restoreRequestId 为幂等键（org_compat_records 兼任幂等事实）；
 * - cancelPositionApplications：worker 调用的幂等取消接口。
 * 恢复兼容性规则：只保留仍存在且可用的部门关系（无有效部门则置空）；岗位不存在或
 * 不再适用于全部保留部门时岗位置空（assigned_by 保留原值——系统操作不改写编排者审计）。
 */
@Injectable()
export class LifecycleService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 恢复预览（只读，不写数据）。
   *
   * @param dto 恢复请求（restoreRequestId + 目标）
   * @returns 逐目标兼容性检查结果
   */
  async restorePreview(dto: HrRestorePreviewDto): Promise<{ targets: RestorePreviewTarget[] }> {
    const targets: RestorePreviewTarget[] = [];
    for (const target of dto.targets) {
      const result = await this.checkCompatibility(target.userId, target.lifecycleVersion);
      if (!result.restorable) {
        targets.push({ userId: target.userId, restorable: false, blockedReasonCode: result.blockedReasonCode });
        continue;
      }
      const check = await this.computeCompatibility(target.userId);
      targets.push({
        userId: target.userId,
        restorable: true,
        removedDepartmentNames: check.clearedDepartments.length > 0 ? check.clearedDepartments.map((d) => d.name) : undefined,
        positionCleared: check.positionCleared || undefined,
      });
    }
    return { targets };
  }

  /**
   * 恢复应用（单事务整批；restoreRequestId 幂等）。
   * 事务内：幂等取消注销前待审批岗位申请 → 组织兼容性清理 → 写 org_compat_records → 版本递增。
   * 任一目标失败整批回滚（4xx 业务码由调用方映射 CONFLICT，重新预览）。
   *
   * @param dto 恢复请求
   * @returns { applied: true }
   * @throws RESTORE_TARGET_STALE 同键不同目标集（409）；任一目标不可处理整批拒绝
   */
  async restoreApply(dto: HrRestoreApplyDto): Promise<{ applied: true }> {
    try {
      await this.prisma.client.$transaction(async (tx) => {
      // 事务内幂等判定（M13）：同 rid 已有记录 → 同目标集重放成功，异目标集 409。
      // 先查后写消除顺序重放的 TOCTOU；并发窗口（双方都查不到）由唯一约束 + P2002 兜底。
      const existing = await tx.orgCompatRecord.findMany({
        where: { restoreRequestId: dto.restoreRequestId },
        distinct: ['userId'],
        select: { userId: true },
      });
      if (existing.length > 0) {
        const existingSet = new Set(existing.map((row) => row.userId));
        const targetSet = new Set(dto.targets.map((target) => target.userId));
        const sameSet = existingSet.size === targetSet.size && [...targetSet].every((id) => existingSet.has(id));
        if (!sameSet) {
          throw new BusinessException(hrErrors.RESTORE_TARGET_STALE);
        }
        return { applied: true };
      }
      for (const target of dto.targets) {
        // 1) 兼容性检查（事务内重跑，防目标漂移）
        const check = await this.checkCompatibility(target.userId, target.lifecycleVersion);
        if (!check.restorable) {
          throw new BusinessException(hrErrors.RESTORE_TARGET_STALE, {
            userId: target.userId,
            reason: check.blockedReasonCode,
          });
        }
        // 2) 幂等取消注销前（submitted_at <= deactivatedAt）仍待审批的岗位申请
        //    （恢复时 hr 停机导致生命周期任务未消费的场景；状态过滤天然幂等）
        await this.cancelPendingPositionApplications(tx, target.userId, target.deactivatedAt);
        // 3) 组织兼容性清理（停用部门关系删除；岗位不适用则置空）
        const compatibility = await this.computeCompatibility(target.userId);
        if (compatibility.clearedDepartments.length > 0) {
          await tx.userDepartment.deleteMany({
            where: { userId: target.userId, departmentId: { in: compatibility.clearedDepartments.map((d) => d.id) } },
          });
        }
        if (compatibility.positionCleared) {
          const current = await tx.userPosition.findUnique({ where: { userId: target.userId } });
          if (current && current.positionId !== null) {
            // assigned_by 保留原值（系统清理不改写编排者审计；H-8 注释登记）
            await tx.userPosition.update({ where: { userId: target.userId }, data: { positionId: null } });
          }
        }
        // 4) 恢复兼容性处理记录（只追加；兼任幂等事实）
        await tx.orgCompatRecord.create({
          data: {
            userId: target.userId,
            restoreRequestId: dto.restoreRequestId,
            clearedDepartments:
              compatibility.clearedDepartments.length > 0
                ? (compatibility.clearedDepartments as Prisma.InputJsonValue)
                : Prisma.DbNull,
            positionCleared: compatibility.positionCleared,
          },
        });
        await bumpUserOrgVersion(tx);
      }
      });
    } catch (error) {
      // 幂等唯一约束兜底（M13）：并发同 restoreRequestId 的请求只有一笔事务成功；
      // 失败方回读已提交记录比对目标集——同集重放成功，异集 RESTORE_TARGET_STALE（409）。
      // 仅当冲突源于 org_compat_records 的 (restore_request_id, user_id) 约束时按幂等处理，
      // 其余唯一冲突（业务键等）原样抛出。
      const constraintName = (error as { meta?: { constraint?: string; target?: unknown } })?.meta?.constraint;
      const isOrgCompatConflict =
        isPrismaUniqueViolation(error) &&
        (constraintName === 'org_compat_records_restore_request_id_user_id_key' ||
          JSON.stringify((error as { meta?: { target?: unknown } })?.meta?.target ?? '')?.includes('restore_request_id'));
      if (isOrgCompatConflict) {
        const committed = await this.prisma.client.orgCompatRecord.findMany({
          where: { restoreRequestId: dto.restoreRequestId },
          distinct: ['userId'],
          select: { userId: true },
        });
        const committedSet = new Set(committed.map((row) => row.userId));
        const targetSet = new Set(dto.targets.map((target) => target.userId));
        const sameSet =
          committedSet.size === targetSet.size && [...targetSet].every((id) => committedSet.has(id));
        if (sameSet) {
          return { applied: true };
        }
        throw new BusinessException(hrErrors.RESTORE_TARGET_STALE);
      }
      throw error;
    }
    return { applied: true };
  }

  /**
   * 幂等取消"注销前已提交且仍待审批"的岗位申请（worker 生命周期任务消费；状态过滤天然幂等）。
   *
   * @param userId 被注销用户
   * @param deactivatedAt 注销时间（ISO）
   * @returns 取消数量
   */
  async cancelPositionApplications(userId: number, deactivatedAt: string): Promise<{ ok: true; cancelledCount: number }> {
    return this.prisma.client.$transaction(async (tx) => {
      return this.cancelPendingPositionApplications(tx, userId, deactivatedAt);
    });
  }

  /** 取消注销前仍待审批的岗位申请（cancelSource=ACCOUNT_DEACTIVATED + AUTO_CANCEL 动作） */
  private async cancelPendingPositionApplications(
    tx: Prisma.TransactionClient,
    userId: number,
    deactivatedAt: string,
  ): Promise<{ ok: true; cancelledCount: number }> {
    const deactivatedAtDate = new Date(deactivatedAt);
    const pending = await tx.hrApprovalRequest.findMany({
      where: {
        requestType: 'POSITION_CHANGE',
        applicantId: userId,
        status: 'PENDING',
        submittedAt: { lte: deactivatedAtDate },
      },
      select: { id: true },
    });
    if (pending.length === 0) {
      return { ok: true, cancelledCount: 0 };
    }
    const now = new Date();
    const actorName = await loadUserName(tx, userId);
    await tx.hrApprovalRequest.updateMany({
      where: { id: { in: pending.map((row) => row.id) }, status: 'PENDING' },
      data: {
        status: 'CANCELLED',
        version: { increment: 1 },
        cancelledAt: now,
        cancelSource: 'ACCOUNT_DEACTIVATED',
      },
    });
    await tx.hrApprovalAction.createMany({
      data: pending.map((row) => ({
        requestId: row.id,
        action: 'AUTO_CANCEL',
        actorId: userId,
        actorName,
        cancelSource: 'ACCOUNT_DEACTIVATED',
      })),
    });
    return { ok: true, cancelledCount: pending.length };
  }

  /** 目标账号可恢复性检查（存在性 + 生命周期版本比对） */
  private async checkCompatibility(
    userId: number,
    lifecycleVersion: number,
  ): Promise<{ restorable: boolean; blockedReasonCode?: string }> {
    const rows = await this.prisma.client.$queryRaw<Array<{ lifecycle_version: number }>>`
      SELECT lifecycle_version FROM backstage.user_accounts WHERE user_id = ${userId} LIMIT 1
    `;
    const current = rows[0];
    if (!current) {
      return { restorable: false, blockedReasonCode: 'USER_NOT_FOUND' };
    }
    if (current.lifecycle_version !== lifecycleVersion) {
      return { restorable: false, blockedReasonCode: 'LIFECYCLE_VERSION_CHANGED' };
    }
    return { restorable: true };
  }

  /** 组织兼容性检查：部门 ACTIVE 保留 / DISABLED 清除；岗位不存在或不适用全部保留部门则置空 */
  private async computeCompatibility(userId: number): Promise<CompatibilityCheck> {
    const deptRows = await this.prisma.client.$queryRaw<
      Array<{ department_id: number; department_name: string; status: string }>
    >`
      SELECT ud.department_id, d.name AS department_name, d.status::text AS status
      FROM hr.user_departments ud
      INNER JOIN hr.departments d ON d.id = ud.department_id
      WHERE ud.user_id = ${userId}
    `;
    const clearedDepartments = deptRows
      .filter((row) => row.status !== 'ACTIVE')
      .map((row) => ({ id: row.department_id, name: row.department_name }));
    const keptDepartmentIds = deptRows.filter((row) => row.status === 'ACTIVE').map((row) => row.department_id);

    const positionRow = await this.prisma.client.$queryRaw<Array<{ position_id: number | null }>>`
      SELECT position_id FROM hr.user_positions WHERE user_id = ${userId} LIMIT 1
    `;
    const positionId = positionRow[0]?.position_id ?? null;
    if (positionId === null) {
      return { clearedDepartments, positionCleared: false };
    }
    if (keptDepartmentIds.length === 0) {
      // 无有效部门 → 岗位不再适用于"全部保留部门"（空集：岗位无从适用，置空）
      return { clearedDepartments, positionCleared: true };
    }
    const position = await this.prisma.client.position.findUnique({ where: { id: positionId } });
    if (!position || position.status !== 'ACTIVE') {
      return { clearedDepartments, positionCleared: true };
    }
    const applicable = await this.prisma.client.positionDepartment.findMany({
      where: { positionId, departmentId: { in: keptDepartmentIds } },
      select: { departmentId: true },
    });
    if (applicable.length !== keptDepartmentIds.length) {
      return { clearedDepartments, positionCleared: true };
    }
    return { clearedDepartments, positionCleared: false };
  }
}
