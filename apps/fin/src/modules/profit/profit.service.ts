import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  FINANCE_MAINTAIN_FUNCTION_CODE,
  financeErrors,
  frameworkErrors,
  type ProfitCellSaveDto,
  type ProjectQueryDto,
} from '@wbme/contracts';
import { Prisma, type Project } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, fingerprintPayload, type FinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { isNonNegativeAmount } from '@wbme/contracts';
import { normalizeProjectName } from '../../shared/name-normalize';
import { buildProjectTableQuery } from '../../shared/project-table-query';
import { calcProjectAutoFields, type ProjectCalcResult } from '../../shared/project-calc';
import {
  formatCalendarDate,
  loadProjectListRows,
  type FieldValue,
  writeProjectChange,
} from '../project/project.service';

/** 单元格即时保存白名单字段（fin PRD §4；自动计算字段不可手工修改） */
export const CELL_FIELDS = [
  'name',
  'year',
  'partyA',
  'generalContractor',
  'managementFee',
  'subcontractors',
  'contractStartDate',
  'contractEndDate',
  'contractAmount',
  'paymentNode',
  'tentativeAuditedAmount',
  'settlement',
  'miscExpense',
  'remark',
  'completenessDocs',
  'regionId',
  'progressId',
  'bizCategoryId',
] as const;

export type CellField = (typeof CELL_FIELDS)[number];

/** 字段值类型（服务端按类型解析与校验 value） */
type CellValueType = 'string' | 'year' | 'date' | 'money' | 'string-array' | 'dict-id' | 'dict-ref-array';

const CELL_FIELD_TYPES: Readonly<Record<CellField, CellValueType>> = {
  name: 'string',
  year: 'year',
  partyA: 'string',
  generalContractor: 'string',
  managementFee: 'string',
  subcontractors: 'string-array',
  contractStartDate: 'date',
  contractEndDate: 'date',
  contractAmount: 'money',
  paymentNode: 'string',
  tentativeAuditedAmount: 'money',
  settlement: 'money',
  miscExpense: 'money',
  remark: 'string',
  completenessDocs: 'dict-ref-array',
  regionId: 'dict-id',
  progressId: 'dict-id',
  bizCategoryId: 'dict-id',
};

/** 总计栏（当前筛选结果汇总；fin PRD §4：不受当前页分页影响） */
export interface ProfitTotals {
  totalReceived: string;
  totalSubcontractPaid: string;
  equity: string;
  grossMargin: string | null;
}

/** LIKE 模糊匹配转义（% _ 按字面匹配） */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 生成筛选 SQL 片段（与列表 where 同条件；参数化） */
function buildFilterSql(query: ProjectQueryDto, params: unknown[]): string {
  const conds = ['p.deleted_at IS NULL'];
  if (query.name) {
    params.push(`%${escapeLike(normalizeProjectName(query.name))}%`);
    conds.push(`p.business_key LIKE $${params.length} ESCAPE '\\'`);
  }
  if (query.partyA) {
    params.push(`%${escapeLike(query.partyA)}%`);
    conds.push(`p.party_a LIKE $${params.length} ESCAPE '\\'`);
  }
  if (query.year !== undefined) {
    params.push(query.year);
    conds.push(`p.year = $${params.length}`);
  }
  if (query.regionId !== undefined) {
    params.push(query.regionId);
    conds.push(`p.region_id = $${params.length}`);
  }
  if (query.bizCategoryId !== undefined) {
    params.push(query.bizCategoryId);
    conds.push(`p.biz_category_id = $${params.length}`);
  }
  if (query.progressId !== undefined) {
    params.push(query.progressId);
    conds.push(`p.progress_id = $${params.length}`);
  }
  return conds.join(' AND ');
}

/**
 * 利润分析服务（fin PRD §4）。
 *
 * - 自动字段由后端基于最新明细实时计算（不保存、不信任前端上传值）；
 * - 单元格即时保存：单字段白名单、只写目标字段（同字段并发以最后提交为准、
 *   不同字段互不覆盖）、每次成功变更递增 dataRevision 并记录字段前后值；
 * - dataRevision 只用于响应排序，不作为保存前置条件（不产生 409）。
 */
@Injectable()
export class ProfitService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 利润分析列表（筛选分页 + 每行自动字段）。
   *
   * @param query 筛选参数
   * @returns items + total（行结构同工程合同列表：项目字段与自动字段展平）
   */
  async list(query: ProjectQueryDto): Promise<{ items: Array<Project & ProjectCalcResult>; total: number }> {
    const where: Prisma.ProjectWhereInput = { deletedAt: null };
    if (query.name) {
      where.businessKey = { contains: normalizeProjectName(query.name) };
    }
    if (query.partyA) {
      where.partyA = { contains: query.partyA };
    }
    if (query.year !== undefined) {
      where.year = query.year;
    }
    if (query.regionId !== undefined) {
      where.regionId = query.regionId;
    }
    if (query.bizCategoryId !== undefined) {
      where.bizCategoryId = query.bizCategoryId;
    }
    if (query.progressId !== undefined) {
      where.progressId = query.progressId;
    }
    const tableQuery = buildProjectTableQuery(query);
    const effectiveWhere: Prisma.ProjectWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.ProjectWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.project.count({ where: effectiveWhere }),
      this.prisma.client.project.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.ProjectOrderByWithRelationInput[] | undefined) ?? [{ year: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: await loadProjectListRows(this.prisma, rows) };
  }

  /**
   * 总计汇总（当前筛选范围全部项目；不受分页影响；金额与毛利率按真实负数/十进制计算）。
   *
   * @param query 筛选参数
   * @returns 总计
   */
  async totals(query: ProjectQueryDto): Promise<ProfitTotals> {
    const params: unknown[] = [];
    const filterSql = buildFilterSql(query, params);
    const rows = await this.prisma.client.$queryRawUnsafe<Array<{ received: string; paid: string; misc: string; count: string }>>(
      `
      SELECT
        COALESCE(SUM((SELECT COALESCE(SUM(amount), 0) FROM fin.receipts r WHERE r.project_id = p.id)), 0)::text AS received,
        COALESCE(SUM((SELECT COALESCE(SUM(amount), 0) FROM fin.subcontract_payments sp WHERE sp.project_id = p.id)), 0)::text AS paid,
        COALESCE(SUM(COALESCE(p.misc_expense, 0)), 0)::text AS misc,
        COUNT(*)::text AS count
      FROM fin.projects p
      WHERE ${filterSql}
      `,
      ...params,
    );
    const row = rows[0];
    const totalReceived = new Prisma.Decimal(row?.received ?? '0');
    const totalPaid = new Prisma.Decimal(row?.paid ?? '0').plus(row?.misc ?? '0');
    const equity = totalReceived.minus(totalPaid);
    const count = Number(row?.count ?? '0');
    return {
      totalReceived: totalReceived.toFixed(2),
      totalSubcontractPaid: totalPaid.toFixed(2),
      equity: equity.toFixed(2),
      grossMargin: count > 0 && !totalReceived.isZero() ? equity.div(totalReceived).toDecimalPlaces(8).toFixed() : null,
    };
  }

  /**
   * 单元格即时保存（单字段白名单；只写目标字段；同字段最后提交为准）。
   *
   * @param operator 操作人
   * @param dto 项目 id + 字段 + 新值 + 幂等键
   * @returns 保存后字段值 + 重新计算的自动字段 + dataRevision
   * @throws CELL_FIELD_NOT_ALLOWED 字段不在白名单或值为空对象
   */
  async cellSave(operator: FinOperationLogOperator, dto: ProfitCellSaveDto): Promise<{ field: CellField; value: unknown; auto: ProjectCalcResult; dataRevision: number }> {
    if (!CELL_FIELDS.includes(dto.field as CellField)) {
      throw new BusinessException(financeErrors.CELL_FIELD_NOT_ALLOWED);
    }
    const field = dto.field as CellField;
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FINANCE_MAINTAIN_FUNCTION_CODE,
      scope: 'fin.profit.cell-save',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        const project = await tx.project.findFirst({ where: { id: dto.projectId, deletedAt: null } });
        if (!project) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const { write, displayValue } = await this.resolveCellValue(tx, project, field, dto.value);
        const before = cellFieldValue(project, field);
        const after = displayValue as FieldValue;
        if (JSON.stringify(before) === JSON.stringify(after)) {
          // 提交前后无实际差异：不产生项目操作记录，仍返回最新自动字段与修订号
          const current = await tx.project.findUniqueOrThrow({ where: { id: dto.projectId } });
          const auto = await this.recalcAuto(tx, current);
          return {
            result: { field, value: displayValue, auto, dataRevision: current.dataRevision },
            actionType: 'UPDATE' as const,
            summary: `在利润分析中保存了项目 ${project.name} 的${field}`,
          };
        }
        // 只写目标字段：不同字段并发互不覆盖；同字段并发以最后提交为准（无版本前置）
        let updated: Project;
        try {
          updated = await tx.project.update({
            where: { id: dto.projectId },
            data: { ...write, dataRevision: { increment: 1 }, updatedBy: operator.id },
          });
        } catch (error) {
          // 并发窗口（预检后他人占用目标业务键）由数据库唯一约束兜底，映射为业务错误而非 500
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(financeErrors.PROJECT_KEY_CONFLICT);
          }
          throw error;
        }
        await writeProjectChange(tx, {
          projectId: dto.projectId,
          operator,
          action: 'EDIT',
          field,
          before,
          after,
        });
        const auto = await this.recalcAuto(tx, updated);
        return {
          result: { field, value: displayValue, auto, dataRevision: updated.dataRevision },
          actionType: 'UPDATE' as const,
          summary: `在利润分析中保存了项目 ${project.name} 的${field}`,
        };
      },
    });
  }

  /** 按字段类型解析并校验单元格新值（字典字段联动快照；名称/年度联动业务键校验） */
  private async resolveCellValue(
    tx: Prisma.TransactionClient,
    project: Project,
    field: CellField,
    value: unknown,
  ): Promise<{ write: Prisma.ProjectUncheckedUpdateInput; displayValue: unknown }> {
    const type = CELL_FIELD_TYPES[field];
    switch (type) {
      case 'string': {
        if (value !== null && typeof value !== 'string') {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '必须为字符串或 null' }] });
        }
        if (value !== null && value.length > 200 && field !== 'remark' && field !== 'paymentNode') {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '文本过长' }] });
        }
        if (field === 'name' && (value === null || value.trim() === '')) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '项目名称不能为空' }] });
        }
        const text = value === null ? null : (value as string);
        const write: Prisma.ProjectUncheckedUpdateInput = { [field]: text };
        if (field === 'name') {
          write.businessKey = normalizeProjectName(text as string);
          await this.assertBusinessKeyFree(tx, project, write.businessKey as string);
        }
        return { write, displayValue: text };
      }
      case 'year': {
        // 兼容字符串与数字两种提交形态（前端输入框提交字符串；统一规范化为整数，批次 3-24）
        const year = typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : value;
        if (typeof year !== 'number' || !Number.isInteger(year) || year < 1000 || year > 9999) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '年度必须是 1000～9999 的整数' }] });
        }
        const write: Prisma.ProjectUncheckedUpdateInput = { year };
        write.businessKey = normalizeProjectName(project.name);
        // 业务键 = 规范化名称 + 目标年度：冲突检查必须用新年度（旧年度会漏检/误检）
        await this.assertBusinessKeyFree(tx, project, write.businessKey as string, year);
        return { write, displayValue: year };
      }
      case 'date': {
        if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '日期必须是 YYYY-MM-DD' }] });
        }
        const date = value === null ? null : new Date(`${value as string}T00:00:00Z`);
        return { write: { [field]: date }, displayValue: value };
      }
      case 'money': {
        if (value !== null && (typeof value !== 'string' || !isNonNegativeAmount(value))) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '金额必须是 ≥ 0 且最多两位小数的十进制字符串' }] });
        }
        const amount = value === null || value === '' ? null : new Prisma.Decimal(value as string);
        // 回显与比较均走 toFixed(2) 规范化（与 before 快照同一口径，避免 "600" 提交被误判为变更）
        return { write: { [field]: amount }, displayValue: amount === null ? null : amount.toFixed(2) };
      }
      case 'string-array': {
        if (!Array.isArray(value)) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '必须为字符串数组' }] });
        }
        if (value.length > 50 || value.some((item) => typeof item !== 'string' || item.length > 200)) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '数组长度或元素长度超限' }] });
        }
        return { write: { [field]: value as string[] }, displayValue: value };
      }
      case 'dict-ref-array': {
        if (!Array.isArray(value)) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '必须为字典引用数组' }] });
        }
        if (value.length > 20 || value.some((item) => typeof item !== 'object' || item === null || typeof (item as { id: unknown }).id !== 'number')) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '数组长度或引用格式非法' }] });
        }
        // 每项必须精确匹配且不得重复（fin PRD §4）：重复引用拒绝保存
        const rawIds = (value as Array<{ id: number }>).map((item) => item.id);
        if (new Set(rawIds).size !== rawIds.length) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '字典引用不得重复' }] });
        }
        const ids = [...new Set(rawIds)];
        const items = await tx.financeDictItem.findMany({ where: { id: { in: ids } } });
        const byId = new Map(items.map((item) => [item.id, item]));
        // 停用项仅允许原引用往返：当前项目已引用同一字典项时保留
        const currentDocs = Array.isArray(project.completenessDocs)
          ? (project.completenessDocs as Array<{ id: number }>)
          : [];
        const normalized = (value as Array<{ id: number; name?: string }>).map((item) => {
          const dict = byId.get(item.id);
          if (!dict) {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '字典项不存在' }] });
          }
          if (dict.dictType !== 'COMPLETENESS') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '只能选择资料齐全度字典项' }] });
          }
          if (dict.status === 'DISABLED' && !currentDocs.some((doc) => doc.id === dict.id)) {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '字典项已停用，不能新选择' }] });
          }
          return { id: dict.id, name: dict.name };
        });
        return { write: { [field]: normalized as Prisma.InputJsonValue }, displayValue: normalized };
      }
      case 'dict-id': {
        if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '必须为字典项 id 或 null' }] });
        }
        const id = value === null ? null : (value as number);
        const snapshotKey =
          field === 'regionId' ? 'regionName' : field === 'progressId' ? 'progressName' : 'bizCategoryName';
        if (id === null) {
          return { write: { [field]: null, [snapshotKey]: null }, displayValue: null };
        }
        const dict = await tx.financeDictItem.findUnique({ where: { id } });
        if (!dict) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '字典项不存在' }] });
        }
        const currentId = field === 'regionId' ? project.regionId : field === 'progressId' ? project.progressId : project.bizCategoryId;
        if (dict.status === 'DISABLED' && dict.id !== currentId) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field, reason: '字典项已停用，不能新选择' }] });
        }
        const write: Prisma.ProjectUncheckedUpdateInput = { [field]: id, [snapshotKey]: dict.name };
        if (field === 'progressId') {
          write.progressSemantic = dict.semantic ?? 'TENTATIVE';
        }
        return { write, displayValue: id };
      }
    }
  }

  /**
   * 业务键唯一校验（排除自身；含软删除占键）。
   *
   * @param tx 事务客户端
   * @param project 当前项目（业务键变化前的行）
   * @param businessKey 目标规范化业务键
   * @param targetYear 目标年度（修改 year 字段时传新年度，否则沿用当前年度）
   */
  private async assertBusinessKeyFree(tx: Prisma.TransactionClient, project: Project, businessKey: string, targetYear: number = project.year): Promise<void> {
    const clash = await tx.project.findFirst({ where: { businessKey, year: targetYear, id: { not: project.id } } });
    if (clash) {
      throw new BusinessException(financeErrors.PROJECT_KEY_CONFLICT);
    }
  }

  /** 基于事务内最新数据重算自动字段（自动字段永不被旧整行数据覆盖） */
  private async recalcAuto(tx: Prisma.TransactionClient, project: Project): Promise<ProjectCalcResult> {
    const [invoices, receipts, payments] = await Promise.all([
      tx.invoice.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } }),
      tx.receipt.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } }),
      tx.subcontractPayment.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } }),
    ]);
    return calcProjectAutoFields(project, { invoices, receipts, subcontractPayments: payments });
  }
}

/** 单元格字段的当前可比较值（before 快照；金额/日期序列化） */
export function cellFieldValue(project: Project, field: CellField): FieldValue {
  const value = project[field];
  if (value instanceof Prisma.Decimal) {
    return value.toFixed(2);
  }
  if (value instanceof Date) {
    return formatCalendarDate(value);
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.parse(JSON.stringify(value)) as FieldValue;
  }
  return (value ?? null) as FieldValue;
}
