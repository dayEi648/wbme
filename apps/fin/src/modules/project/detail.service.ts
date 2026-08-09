import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  FINANCE_MAINTAIN_FUNCTION_CODE,
  frameworkErrors,
  type FinanceDetailCreateDto,
  type FinanceDetailUpdateDto,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, fingerprintPayload, type FinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { writeProjectChange, formatCalendarDate } from './project.service';

/** 金额明细类型 → Prisma 委托方法（F-2/F-3/F-4 三表同构） */
type DetailKind = 'invoice' | 'receipt' | 'subcontract-payment';

/** 明细类型 → Prisma 委托键（驼峰委托名） */
const DETAIL_DELEGATE: Record<DetailKind, 'invoice' | 'receipt' | 'subcontractPayment'> = {
  invoice: 'invoice',
  receipt: 'receipt',
  'subcontract-payment': 'subcontractPayment',
};

/** 明细类型 → 展示名（操作记录/摘要用） */
export const DETAIL_KIND_NAMES: Record<DetailKind, string> = {
  invoice: '开票金额',
  receipt: '已收回款',
  'subcontract-payment': '已付分包款',
};

/** 明细表名（操作记录 before/after 快照键） */
export const DETAIL_KIND_FIELDS: Record<DetailKind, string> = {
  invoice: 'invoices',
  receipt: 'receipts',
  'subcontract-payment': 'subcontractPayments',
};

/** 明细行最小形状（三表同构；快照与写入共用） */
export interface DetailRow {
  id: number;
  amount: Prisma.Decimal;
  occurredDate: Date | null;
  remark: string | null;
}

/** 明细委托最小操作面（三表同构，运行时均为同一签名） */
interface DetailOps {
  create(args: { data: { projectId: number; amount: Prisma.Decimal; occurredDate: Date | null; remark: string | null } }): Promise<DetailRow>;
  update(args: { where: { id: number }; data: { amount: Prisma.Decimal; occurredDate: Date | null; remark: string | null } }): Promise<DetailRow>;
  delete(args: { where: { id: number } }): Promise<DetailRow>;
  findFirst(args: { where: { id: number; projectId: number } }): Promise<DetailRow | null>;
}

/** 取明细委托（三表结构一致，按类型断言到最小操作面） */
function detailOps(tx: Prisma.TransactionClient, kind: DetailKind): DetailOps {
  return tx[DETAIL_DELEGATE[kind]] as unknown as DetailOps;
}

/** 明细快照（删除前完整快照 / 变更前后值；键值均为可比较值） */
function detailSnapshot(row: DetailRow): Record<string, string | number | null> {
  return {
    id: row.id,
    amount: row.amount.toFixed(2),
    occurredDate: row.occurredDate ? formatCalendarDate(row.occurredDate) : null,
    remark: row.remark,
  };
}

/** 解析明细输入为写入数据（金额 Decimal、日期日历串转 Date；projectId 由调用方补充） */
function parseDetailItem(item: FinanceDetailCreateDto['item']): { amount: Prisma.Decimal; occurredDate: Date | null; remark: string | null } {
  return {
    amount: new Prisma.Decimal(item.amount),
    occurredDate: item.occurredDate ? new Date(`${item.occurredDate}T00:00:00Z`) : null,
    remark: item.remark ?? null,
  };
}

/**
 * 金额明细服务（fin PRD §3/§4；F-2/F-3/F-4）。
 *
 * 每次只变更一条明细；单条物理删除例外（主 PRD §2.6：删除前在同一事务写入
 * 完整删除前快照审计，审计失败删除同步回滚）。每次成功变更递增项目 dataRevision
 * （自动字段与 Excel 覆盖前置条件依赖）。
 */
@Injectable()
export class DetailService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 明细新增（校验项目存在未删除；每次一条）。
   *
   * @param operator 操作人
   * @param projectId 所属项目
   * @param kind 明细类型
   * @param dto 明细输入
   * @returns 明细 id
   */
  async create(
    operator: FinOperationLogOperator,
    projectId: number,
    kind: DetailKind,
    dto: FinanceDetailCreateDto,
  ): Promise<{ id: number }> {
    return this.runDetailChange(operator, projectId, kind, dto.idempotencyKey, `fin.detail.${kind}.create`, dto, async (tx, row) => {
      const parsed = parseDetailItem(dto.item);
      const created = await detailOps(tx, kind).create({
        data: { amount: parsed.amount, occurredDate: parsed.occurredDate, remark: parsed.remark, projectId },
      });
      await writeProjectChange(tx, {
        projectId,
        operator,
        action: 'EDIT',
        field: DETAIL_KIND_FIELDS[kind],
        before: null,
        after: detailSnapshot(created),
      });
      return {
        result: { id: created.id },
        actionType: 'CREATE' as const,
        summary: `在财务数据维护中为项目 ${row.name} 新增了${DETAIL_KIND_NAMES[kind]}记录`,
      };
    });
  }

  /**
   * 明细修改（每次一条；前后无实际差异不产生操作记录）。
   *
   * @param operator 操作人
   * @param projectId 所属项目
   * @param kind 明细类型
   * @param detailId 明细 id
   * @param dto 明细输入
   * @returns 明细 id
   */
  async update(
    operator: FinOperationLogOperator,
    projectId: number,
    kind: DetailKind,
    detailId: number,
    dto: FinanceDetailUpdateDto,
  ): Promise<{ id: number }> {
    return this.runDetailChange(operator, projectId, kind, dto.idempotencyKey, `fin.detail.${kind}.update`, dto, async (tx, row) => {
      const existing = await detailOps(tx, kind).findFirst({ where: { id: detailId, projectId } });
      if (!existing) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      const next = parseDetailItem(dto.item);
      const before = detailSnapshot(existing);
      const after = {
        id: existing.id,
        amount: dto.item.amount,
        occurredDate: dto.item.occurredDate ?? null,
        remark: dto.item.remark ?? null,
      };
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return {
          result: { id: detailId },
          actionType: 'UPDATE' as const,
          summary: `在财务数据维护中修改了项目 ${row.name} 的${DETAIL_KIND_NAMES[kind]}记录`,
        };
      }
      const updated = await detailOps(tx, kind).update({
        where: { id: detailId },
        data: { amount: next.amount, occurredDate: next.occurredDate ?? null, remark: next.remark ?? null },
      });
      await writeProjectChange(tx, {
        projectId,
        operator,
        action: 'EDIT',
        field: DETAIL_KIND_FIELDS[kind],
        before,
        after: detailSnapshot(updated),
      });
      return {
        result: { id: updated.id },
        actionType: 'UPDATE' as const,
        summary: `在财务数据维护中修改了项目 ${row.name} 的${DETAIL_KIND_NAMES[kind]}记录`,
      };
    });
  }

  /**
   * 明细单条物理删除（主 PRD §2.6 财务金额明细单条硬删除例外：
   * 同事务写入完整删除前快照审计，审计失败删除同步回滚，删除后不可恢复）。
   *
   * @param operator 操作人
   * @param projectId 所属项目
   * @param kind 明细类型
   * @param detailId 明细 id
   * @returns 删除结果
   */
  async remove(operator: FinOperationLogOperator, projectId: number, kind: DetailKind, detailId: number): Promise<{ ok: true }> {
    return this.runDetailChange(operator, projectId, kind, undefined, `fin.detail.${kind}.delete`, { id: detailId }, async (tx, row) => {
      const existing = await detailOps(tx, kind).findFirst({ where: { id: detailId, projectId } });
      if (!existing) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      await detailOps(tx, kind).delete({ where: { id: detailId } });
      await writeProjectChange(tx, {
        projectId,
        operator,
        action: 'EDIT',
        field: DETAIL_KIND_FIELDS[kind],
        before: detailSnapshot(existing),
        after: null,
      });
      return {
        result: { ok: true as const },
        actionType: 'DELETE' as const,
        summary: `在财务数据维护中删除了项目 ${row.name} 的一条${DETAIL_KIND_NAMES[kind]}记录`,
      };
    });
  }

  /**
   * 明细变更通用事务封装：校验项目 → 递增 dataRevision → 业务写入 + 项目操作记录（同事务）。
   */
  private async runDetailChange<T>(
    operator: FinOperationLogOperator,
    projectId: number,
    kind: DetailKind,
    idempotencyKey: string | undefined,
    scope: string,
    fingerprintInput: object,
    run: (tx: Prisma.TransactionClient, project: { id: number; name: string }) => Promise<{
      result: T;
      actionType: 'CREATE' | 'UPDATE' | 'DELETE';
      summary: string;
    }>,
  ): Promise<T> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FINANCE_MAINTAIN_FUNCTION_CODE,
      scope,
      idempotencyKey,
      fingerprint: fingerprintPayload({ projectId, kind, ...fingerprintInput }),
      run: async (tx) => {
        const project = await tx.project.findFirst({ where: { id: projectId, deletedAt: null } });
        if (!project) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const outcome = await run(tx, project);
        // 每次成功变更递增项目 dataRevision（fin PRD §4）
        await tx.project.update({
          where: { id: projectId },
          data: { dataRevision: { increment: 1 }, updatedBy: operator.id },
        });
        return outcome;
      },
    });
  }
}
