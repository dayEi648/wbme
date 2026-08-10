import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  FINANCE_MAINTAIN_FUNCTION_CODE,
  financeErrors,
  frameworkErrors,
  type ProjectCreateDto,
  type ProjectQueryDto,
} from '@wbme/contracts';
import { Prisma, type FinanceDictItem, type Project } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, fingerprintPayload, type FinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { normalizeProjectName } from '../../shared/name-normalize';
import { buildProjectTableQuery } from '../../shared/project-table-query';
import { calcProjectAutoFields, type ProjectCalcResult } from '../../shared/project-calc';

/** 项目字段可比较值（用于变更 diff 与操作记录快照；金额转字符串、日期转日历串） */
export type FieldValue = string | number | boolean | null | Array<unknown> | Record<string, unknown>;

/** 项目可编辑字段清单（fin PRD §3；name/year 亦允许随时修改） */
const PROJECT_FIELDS = [
  'name',
  'year',
  'completenessDocs',
  'regionId',
  'progressId',
  'bizCategoryId',
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
] as const;

/** 项目操作记录变更条目（同事务写入 F-5） */
export interface ProjectChangeRecord {
  projectId: number;
  operator: FinOperationLogOperator;
  action: 'CREATE' | 'EDIT' | 'DELETE' | 'IMPORT_CREATE' | 'IMPORT_OVERWRITE' | 'IMPORT_SKIP';
  /** 单字段即时保存时的字段名（多字段编辑/整表导入为 null） */
  field?: string | null;
  /** 变更前值（单字段）或变更字段映射（多字段）；删除为完整删除前快照 */
  before?: Record<string, FieldValue> | FieldValue | null;
  /** 变更后值 */
  after?: Record<string, FieldValue> | FieldValue | null;
}

/** 项目行输出（含明细与自动字段；列表与详情共用） */
export interface ProjectWithDetails {
  project: Project;
  details: {
    invoices: Array<{ id: number; amount: string; occurredDate: string | null; remark: string | null }>;
    receipts: Array<{ id: number; amount: string; occurredDate: string | null; remark: string | null }>;
    subcontractPayments: Array<{ id: number; amount: string; occurredDate: string | null; remark: string | null }>;
  };
  auto: ProjectCalcResult;
}

/** 字典快照解析结果 */
interface DictSnapshots {
  regionName: string | null;
  progressName: string | null;
  progressSemantic: 'TENTATIVE' | 'AUDITED' | null;
  bizCategoryName: string | null;
}

/**
 * 项目主档服务（fin PRD §3；F-1）。
 *
 * 业务键（规范化名称 + 年度）数据库唯一约束含软删除行：软删除记录仍占用业务键，
 * 同名新建必须提示进入已删除视图恢复或改名。金额明细增删改与自动字段计算见
 * detail.service / project-calc；变更审计（F-5 项目操作记录）与业务写入同一事务。
 */
@Injectable()
export class ProjectService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 项目新建（名称 + 年度业务唯一键；字典快照落库）。
   *
   * @param operator 操作人
   * @param dto 项目输入
   * @returns 项目 id
   * @throws PROJECT_KEY_CONFLICT 业务键冲突（含软删除占键）
   */
  async create(operator: FinOperationLogOperator, dto: ProjectCreateDto): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FINANCE_MAINTAIN_FUNCTION_CODE,
      scope: 'fin.project.create',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        const snapshots = await this.resolveDictSnapshots(tx, dto);
        const businessKey = normalizeProjectName(dto.name);
        try {
          const row = await tx.project.create({
            data: buildProjectData(dto, businessKey, snapshots, operator.id),
          });
          await writeProjectChange(tx, {
            projectId: row.id,
            operator,
            action: 'CREATE',
            after: projectSnapshot(row),
          });
          return {
            result: { id: row.id },
            actionType: 'CREATE' as const,
            summary: `在工程合同管理中新增了项目 ${dto.name}`,
          };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(financeErrors.PROJECT_KEY_CONFLICT);
          }
          throw error;
        }
      },
    });
  }

  /**
   * 项目编辑（名称/年度允许随时修改；保存时校验新业务键；无实际差异不产生操作记录）。
   *
   * @param operator 操作人
   * @param id 项目 id
   * @param dto 项目输入
   * @returns 项目 id
   */
  async update(operator: FinOperationLogOperator, id: number, dto: ProjectCreateDto): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FINANCE_MAINTAIN_FUNCTION_CODE,
      scope: 'fin.project.update',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload({ id, ...dto }),
      run: async (tx) => {
        const existing = await tx.project.findFirst({ where: { id, deletedAt: null } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const snapshots = await this.resolveDictSnapshots(tx, dto, existing);
        const businessKey = normalizeProjectName(dto.name);
        const diff = diffProject(existing, dto, businessKey, snapshots);
        if (diff.changed.size === 0) {
          // 提交前后无实际差异：不产生项目操作记录（fin PRD §5），直接返回
          return { result: { id }, actionType: 'UPDATE' as const, summary: `更新了项目 ${dto.name}` };
        }
        try {
          await tx.project.update({
            where: { id },
            data: {
              ...buildProjectData(dto, businessKey, snapshots, operator.id, existing),
              // 每次成功变更递增 dataRevision（fin PRD §4）；预览快照以此校验导入覆盖过期
              dataRevision: { increment: 1 },
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(financeErrors.PROJECT_KEY_CONFLICT);
          }
          throw error;
        }
        await writeProjectChange(tx, {
          projectId: id,
          operator,
          action: 'EDIT',
          before: diff.before,
          after: diff.after,
        });
        return {
          result: { id },
          actionType: 'UPDATE' as const,
          summary: `在工程合同管理中修改了项目 ${existing.name}`,
        };
      },
    });
  }

  /**
   * 项目批量软删除（全有或全无：任一目标不存在或已删除则整批回滚并返回失败明细）。
   *
   * @param operator 操作人
   * @param ids 目标 id 列表
   * @returns 删除数量
   * @throws VALIDATION_FAILED 部分目标不可删除（fields.failedIds 明细）
   */
  async batchDelete(operator: FinOperationLogOperator, ids: readonly number[], idempotencyKey?: string): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FINANCE_MAINTAIN_FUNCTION_CODE,
      scope: 'fin.project.delete',
      idempotencyKey,
      fingerprint: fingerprintPayload({ ids }),
      run: async (tx) => {
        const rows = await tx.project.findMany({ where: { id: { in: [...ids] } } });
        const existing = rows.filter((row) => row.deletedAt === null);
        if (existing.length !== ids.length) {
          const failed = ids.filter((id) => !existing.some((row) => row.id === id));
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
            fields: failed.map((id) => ({ id, reason: '项目不存在或已删除' })),
          });
        }
        const now = new Date();
        await tx.project.updateMany({
          where: { id: { in: existing.map((row) => row.id) } },
          data: { deletedBy: operator.id, deletedAt: now },
        });
        for (const row of existing) {
          await writeProjectChange(tx, {
            projectId: row.id,
            operator,
            action: 'DELETE',
            before: projectSnapshot(row),
          });
        }
        return {
          result: { deleted: existing.length },
          actionType: 'DELETE' as const,
          summary: `在工程合同管理中删除了 ${existing.length} 个项目`,
        };
      },
    });
  }

  /**
   * 已删除项目批量恢复（fin PRD §3：保留原 ID/业务键/合同与利润数据/操作历史；
   * 全有或全无，任一目标不存在或未删除则整批回滚）。
   *
   * @param operator 操作人
   * @param ids 目标 id 列表
   * @returns 恢复数量
   */
  async batchRestore(operator: FinOperationLogOperator, ids: readonly number[], idempotencyKey?: string): Promise<{ restored: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FINANCE_MAINTAIN_FUNCTION_CODE,
      scope: 'fin.project.restore',
      idempotencyKey,
      fingerprint: fingerprintPayload({ ids }),
      run: async (tx) => {
        const rows = await tx.project.findMany({ where: { id: { in: [...ids] } } });
        const deleted = rows.filter((row) => row.deletedAt !== null);
        if (deleted.length !== ids.length) {
          const failed = ids.filter((id) => !deleted.some((row) => row.id === id));
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
            fields: failed.map((id) => ({ id, reason: '项目不存在或未删除' })),
          });
        }
        await tx.project.updateMany({
          where: { id: { in: deleted.map((row) => row.id) } },
          // 恢复属成功变更：递增 dataRevision（fin PRD §4），预览快照据此失效
          data: { deletedBy: null, deletedAt: null, dataRevision: { increment: 1 } },
        });
        for (const row of deleted) {
          await writeProjectChange(tx, {
            projectId: row.id,
            operator,
            action: 'EDIT',
            field: 'deletedAt',
            before: { deletedAt: row.deletedAt?.toISOString() ?? null },
            after: null,
          });
        }
        return {
          result: { restored: deleted.length },
          actionType: 'UPDATE' as const,
          summary: `在工程合同管理中恢复了 ${deleted.length} 个项目`,
        };
      },
    });
  }

  /**
   * 项目列表（筛选分页；默认正常视图排除软删除，view=deleted 查已删除视图）。
   *
   * @param query 筛选参数
   * @param includeDeleted 是否查已删除视图
   * @returns items（含明细与自动字段）+ total
   */
  async list(query: ProjectQueryDto, includeDeleted: boolean): Promise<{ items: ProjectWithDetails[]; total: number }> {
    const where: Prisma.ProjectWhereInput = includeDeleted
      ? { deletedAt: { not: null } }
      : { deletedAt: null };
    if (query.name) {
      // 名称按规范化规则模糊匹配（fin PRD §3：页面与导入使用完全相同规则）
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
    return { total, items: await loadProjectsWithDetails(this.prisma, rows) };
  }

  /**
   * 项目详情（含三类金额明细与自动字段）。
   *
   * @param id 项目 id
   * @param includeDeleted 是否允许读取已删除项目（恢复视图只读不提供详情）
   * @returns 项目 + 明细 + 自动字段
   * @throws RESOURCE_NOT_FOUND 不存在或已删除
   */
  async getDetail(id: number): Promise<ProjectWithDetails> {
    const row = await this.prisma.client.project.findFirst({ where: { id, deletedAt: null } });
    if (!row) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const items = await loadProjectsWithDetails(this.prisma, [row]);
    // findFirst 已确认存在，行必然命中
    return items[0] as ProjectWithDetails;
  }

  /**
   * 解析并校验字典引用（页面新建/编辑只允许启用项；编辑时保留已引用停用项原引用往返）。
   *
   * @param tx 事务客户端
   * @param dto 项目输入
   * @param existing 现有项目（编辑时用于原引用往返判定）
   * @returns 字典名称/语义快照
   * @throws VALIDATION_FAILED 字典项不存在或已停用
   */
  private async resolveDictSnapshots(
    tx: Prisma.TransactionClient,
    dto: Pick<ProjectCreateDto, 'regionId' | 'progressId' | 'bizCategoryId'>,
    existing?: Project,
  ): Promise<DictSnapshots> {
    const refs: Array<{ id?: number; currentId?: number | null; kind: keyof DictSnapshots }> = [
      { id: dto.regionId, currentId: existing?.regionId, kind: 'regionName' },
      { id: dto.progressId, currentId: existing?.progressId, kind: 'progressName' },
      { id: dto.bizCategoryId, currentId: existing?.bizCategoryId, kind: 'bizCategoryName' },
    ];
    const result: DictSnapshots = { regionName: null, progressName: null, progressSemantic: null, bizCategoryName: null };
    const dictIds = [...new Set(refs.filter((ref) => ref.id !== undefined && ref.id !== null).map((ref) => ref.id as number))];
    if (dictIds.length === 0) {
      return result;
    }
    const items = await tx.financeDictItem.findMany({ where: { id: { in: dictIds } } });
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const ref of refs) {
      if (ref.id === undefined || ref.id === null) {
        continue;
      }
      const item = byId.get(ref.id);
      if (!item) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
          fields: [{ field: ref.kind, reason: '字典项不存在' }],
        });
      }
      // 停用项仅允许原引用往返：目标已引用同一记录时保留，否则拒绝（fin PRD §4 停用项规则）
      if (item.status === 'DISABLED' && item.id !== ref.currentId) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
          fields: [{ field: ref.kind, reason: '字典项已停用，不能新选择' }],
        });
      }
      if (ref.kind === 'regionName') {
        result.regionName = item.name;
      } else if (ref.kind === 'progressName') {
        result.progressName = item.name;
        result.progressSemantic = item.semantic ?? 'TENTATIVE';
      } else {
        result.bizCategoryName = item.name;
      }
    }
    return result;
  }
}

/** 构建项目写入数据（新建用 createdBy；编辑保留 createdBy） */
function buildProjectData(
  dto: ProjectCreateDto,
  businessKey: string,
  snapshots: DictSnapshots,
  operatorId: number,
  existing?: Project,
): Prisma.ProjectUncheckedCreateInput {
  return {
    name: dto.name,
    year: dto.year,
    businessKey,
    completenessDocs: dto.completenessDocs as unknown as Prisma.InputJsonValue,
    regionId: dto.regionId ?? null,
    regionName: snapshots.regionName,
    progressId: dto.progressId ?? null,
    progressName: snapshots.progressName,
    progressSemantic: snapshots.progressSemantic,
    bizCategoryId: dto.bizCategoryId ?? null,
    bizCategoryName: snapshots.bizCategoryName,
    partyA: dto.partyA ?? null,
    generalContractor: dto.generalContractor ?? null,
    managementFee: dto.managementFee ?? null,
    subcontractors: dto.subcontractors ?? [],
    contractStartDate: dto.contractStartDate ? new Date(`${dto.contractStartDate}T00:00:00Z`) : null,
    contractEndDate: dto.contractEndDate ? new Date(`${dto.contractEndDate}T00:00:00Z`) : null,
    contractAmount: dto.contractAmount !== undefined && dto.contractAmount !== '' ? new Prisma.Decimal(dto.contractAmount) : null,
    paymentNode: dto.paymentNode ?? null,
    tentativeAuditedAmount:
      dto.tentativeAuditedAmount !== undefined && dto.tentativeAuditedAmount !== '' ? new Prisma.Decimal(dto.tentativeAuditedAmount) : null,
    settlement: dto.settlement !== undefined && dto.settlement !== '' ? new Prisma.Decimal(dto.settlement) : null,
    miscExpense: dto.miscExpense !== undefined && dto.miscExpense !== '' ? new Prisma.Decimal(dto.miscExpense) : null,
    remark: dto.remark ?? null,
    createdBy: existing?.createdBy ?? operatorId,
    updatedBy: operatorId,
  };
}

/** 字段可比较值（金额 → 两位小数字符串；日期 → 日历串；JSON → 序列化） */
function fieldValue(row: Project, field: (typeof PROJECT_FIELDS)[number]): FieldValue {
  const value = row[field];
  if (value instanceof Prisma.Decimal) {
    return value.toFixed(2);
  }
  if (value instanceof Date) {
    return formatCalendarDate(value);
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.parse(JSON.stringify(value)) as Array<unknown>;
  }
  return (value ?? null) as FieldValue;
}

/** 项目操作记录快照（完整项目值，用于 CREATE/IMPORT 快照与 DELETE 删除前快照） */
function projectSnapshot(row: Project): Record<string, FieldValue> {
  const snapshot: Record<string, FieldValue> = {};
  for (const field of PROJECT_FIELDS) {
    snapshot[field] = fieldValue(row, field);
  }
  return snapshot;
}

/** 编辑差异：计算有变化的字段及其前后值（数组/对象按序列化比较） */
function diffProject(
  existing: Project,
  dto: ProjectCreateDto,
  businessKey: string,
  snapshots: DictSnapshots,
): { changed: Set<string>; before: Record<string, FieldValue>; after: Record<string, FieldValue> } {
  const before: Record<string, FieldValue> = {};
  const after: Record<string, FieldValue> = {};
  const changed = new Set<string>();
  const dtoValues: Record<string, FieldValue> = {
    name: dto.name,
    year: dto.year,
    completenessDocs: dto.completenessDocs ?? null,
    regionId: dto.regionId ?? null,
    progressId: dto.progressId ?? null,
    bizCategoryId: dto.bizCategoryId ?? null,
    partyA: dto.partyA ?? null,
    generalContractor: dto.generalContractor ?? null,
    managementFee: dto.managementFee ?? null,
    subcontractors: dto.subcontractors ?? [],
    contractStartDate: dto.contractStartDate ?? null,
    contractEndDate: dto.contractEndDate ?? null,
    contractAmount: dto.contractAmount !== undefined && dto.contractAmount !== '' ? dto.contractAmount : null,
    paymentNode: dto.paymentNode ?? null,
    tentativeAuditedAmount:
      dto.tentativeAuditedAmount !== undefined && dto.tentativeAuditedAmount !== '' ? dto.tentativeAuditedAmount : null,
    settlement: dto.settlement !== undefined && dto.settlement !== '' ? dto.settlement : null,
    miscExpense: dto.miscExpense !== undefined && dto.miscExpense !== '' ? dto.miscExpense : null,
    remark: dto.remark ?? null,
  };
  // 名称/年度变更会带出业务键与字典快照变化：按存储字段逐一比较
  for (const field of PROJECT_FIELDS) {
    const oldValue = fieldValue(existing, field);
    const newValue = dtoValues[field] ?? null;
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changed.add(field);
      before[field] = oldValue;
      after[field] = newValue;
    }
  }
  // 字典快照变化（名称/语义；与字典 id 变更联动，比较存储快照与解析快照）
  const snapshotPairs: Array<[keyof DictSnapshots, string | null]> = [
    ['regionName', existing.regionName],
    ['progressName', existing.progressName],
    ['bizCategoryName', existing.bizCategoryName],
  ];
  for (const [key, oldName] of snapshotPairs) {
    const newName = snapshots[key];
    if ((oldName ?? null) !== newName) {
      changed.add(key);
      before[key] = oldName;
      after[key] = newName;
    }
  }
  if ((existing.progressSemantic ?? 'TENTATIVE') !== (snapshots.progressSemantic ?? 'TENTATIVE')) {
    changed.add('progressSemantic');
    before.progressSemantic = existing.progressSemantic ?? 'TENTATIVE';
    after.progressSemantic = snapshots.progressSemantic ?? 'TENTATIVE';
  }
  return { changed, before, after };
}

/** 写入项目操作记录（F-5；与业务变更同一事务；无实际差异时调用方不调用） */
export async function writeProjectChange(
  tx: Prisma.TransactionClient,
  record: ProjectChangeRecord,
): Promise<void> {
  await tx.projectOperation.create({
    data: {
      projectId: record.projectId,
      operatorId: record.operator.id,
      operatorName: record.operator.name,
      action: record.action,
      field: record.field ?? null,
      // 可空 jsonb：null 语义用 Prisma.DbNull（SQL NULL）
      before: record.before === null || record.before === undefined ? Prisma.DbNull : (record.before as unknown as Prisma.InputJsonValue),
      after: record.after === null || record.after === undefined ? Prisma.DbNull : (record.after as unknown as Prisma.InputJsonValue),
    },
  });
}

/** Date → YYYY-MM-DD 日历串（UTC 构造的日期不受时区偏移影响） */
export function formatCalendarDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** 字典项引用计数（供字典删除引用检查与语义锁定检查；fin PRD §6） */
export async function countProjectRefs(
  tx: Prisma.TransactionClient,
  ids: readonly number[],
): Promise<{ region: number; progress: number; bizCategory: number }> {
  const rows = await tx.$queryRaw<Array<{ region: bigint; progress: bigint; biz_category: bigint }>>`
    SELECT
      (SELECT COUNT(*) FROM fin.projects WHERE region_id = ANY(${ids as number[]})) AS region,
      (SELECT COUNT(*) FROM fin.projects WHERE progress_id = ANY(${ids as number[]})) AS progress,
      (SELECT COUNT(*) FROM fin.projects WHERE biz_category_id = ANY(${ids as number[]})) AS biz_category
  `;
  const row = rows[0];
  return {
    region: Number(row?.region ?? 0),
    progress: Number(row?.progress ?? 0),
    bizCategory: Number(row?.biz_category ?? 0),
  };
}

/** 查询字典项快照（导入/导出共用；按 id 批量） */
export async function loadDictItems(
  tx: Prisma.TransactionClient,
  ids: readonly number[],
): Promise<FinanceDictItem[]> {
  if (ids.length === 0) {
    return [];
  }
  return tx.financeDictItem.findMany({ where: { id: { in: [...ids] } } });
}

/**
 * 批量加载项目明细并计算自动字段（集合化查询，避免 N+1；列表/详情/利润分析共用）。
 *
 * @param prisma Prisma 服务
 * @param rows 项目主档行
 * @returns 行 + 明细 + 自动字段
 */
export async function loadProjectsWithDetails(prisma: PrismaService, rows: readonly Project[]): Promise<ProjectWithDetails[]> {
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((row) => row.id);
  const [invoices, receipts, subcontractPayments] = await Promise.all([
    prisma.client.invoice.findMany({ where: { projectId: { in: ids } }, orderBy: { id: 'asc' } }),
    prisma.client.receipt.findMany({ where: { projectId: { in: ids } }, orderBy: { id: 'asc' } }),
    prisma.client.subcontractPayment.findMany({ where: { projectId: { in: ids } }, orderBy: { id: 'asc' } }),
  ]);
  const byProject = <T extends { projectId: number }>(list: readonly T[]): Map<number, T[]> => {
    const map = new Map<number, T[]>();
    for (const item of list) {
      const bucket = map.get(item.projectId) ?? [];
      bucket.push(item);
      map.set(item.projectId, bucket);
    }
    return map;
  };
  const invoiceMap = byProject(invoices);
  const receiptMap = byProject(receipts);
  const paymentMap = byProject(subcontractPayments);

  return rows.map((project) => {
    const projectInvoices = invoiceMap.get(project.id) ?? [];
    const projectReceipts = receiptMap.get(project.id) ?? [];
    const projectPayments = paymentMap.get(project.id) ?? [];
    const fmtDetail = (row: { id: number; amount: Prisma.Decimal; occurredDate: Date | null; remark: string | null }) => ({
      id: row.id,
      amount: row.amount.toFixed(2),
      occurredDate: row.occurredDate ? formatCalendarDate(row.occurredDate) : null,
      remark: row.remark,
    });
    return {
      project,
      details: {
        invoices: projectInvoices.map(fmtDetail),
        receipts: projectReceipts.map(fmtDetail),
        subcontractPayments: projectPayments.map(fmtDetail),
      },
      auto: calcProjectAutoFields(project, {
        invoices: projectInvoices,
        receipts: projectReceipts,
        subcontractPayments: projectPayments,
      }),
    };
  });
}
