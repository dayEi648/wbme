import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, exportErrors, financeErrors, FINANCE_MAINTAIN_FUNCTION_CODE, frameworkErrors, type ImportChoiceDto } from '@wbme/contracts';
import type { Redis } from '@wbme/server';
import { createHash, randomUUID } from 'node:crypto';
import { getRequestImportLockRelease, REDIS_CLIENT, REDIS_NAMESPACE, redisKey } from '@wbme/server';
import { Prisma, type Project } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, fingerprintPayload, type FinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { normalizeProjectName } from '../../shared/name-normalize';
import { splitMultiValue, type ParseFailure, type ParsedRow, type RowError } from './import-parser';
import { XlsxWorkerPool } from './xlsx-worker-pool';
import { COL, UNCLASSIFIED_GROUP } from './xlsx-template';

/** 导入总时限（毫秒）：120 秒（fin PRD §4 固定值） */
export const IMPORT_TIMEOUT_MS = 120_000;

/** 确认写入分批大小（每批一条 createManyAndReturn；批间检查点供取消/超时传播） */
const CREATE_BATCH_SIZE = 500;

/**
 * 导入取消/超时检查器（fin PRD §4：120s；客户端断连/响应关闭也触发取消）。
 *
 * 预览与确认各关键步骤（解析/匹配/每行写入）间调用；确认写入在事务内，
 * 取消或超时抛错使整批回滚（全有或全无，不留部分导入）。
 *
 * @param signal 客户端/响应取消信号
 * @returns 检查函数（从创建时刻起计算 deadline）
 */
function makeImportTimeoutCheck(signal?: AbortSignal): () => void {
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  return () => {
    if (signal?.aborted) {
      throw new BusinessException(frameworkErrors.REQUEST_TIMEOUT);
    }
    if (Date.now() > deadline) {
      throw new BusinessException(exportErrors.IMPORT_TIMEOUT);
    }
  };
}

/** 导入锁 TTL（比总时限多 30s，防极端时序下并发语义失效） */
const IMPORT_LOCK_TTL_SECONDS = Math.ceil(IMPORT_TIMEOUT_MS / 1000) + 30;

/** 释放锁 Lua：仅当锁值仍为本请求令牌时才删除 */
const RELEASE_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/** 项目行解析结果（结构化输入；供匹配/写入） */
interface ProjectRowInput {
  rowNumber: number;
  name: string;
  year: number | null;
  /** 分组上下文分类名（“未分类”→ null） */
  groupName: string | null;
  completenessDocs: string[];
  regionName: string | null;
  progressName: string | null;
  partyA: string | null;
  generalContractor: string | null;
  managementFee: string | null;
  subcontractors: string[];
  contractStartDate: string | null;
  contractEndDate: string | null;
  contractAmount: string | null;
  paymentNode: string | null;
  tentativeAuditedAmount: string | null;
  invoices: string[];
  receipts: string[];
  remark: string | null;
  settlement: string | null;
  subcontractPayments: string[];
  miscExpense: string | null;
}

/** 预览行条目（精简；不回传整行 28 列副本） */
export interface PreviewRowItem {
  rowNumber: number;
  name: string;
  year: number | null;
  bizCategory: string | null;
}

/** 待选择条目（覆盖/跳过；携带 dataRevision 与数据丢失警告） */
export interface PendingChoiceItem extends PreviewRowItem {
  projectId: number;
  dataRevision: number;
  /** 覆盖将永久删除原明细的日期与单笔备注（确认前必须显示且不可跳过阅读的警告） */
  dataLossWarning: boolean;
}

/** 冲突条目（软删除命中 / 同名歧义 / 文件内重复） */
export interface ConflictItem extends PreviewRowItem {
  status: 'DELETED' | 'AMBIGUOUS' | 'DUPLICATE';
  reason: string;
}

/** 错误条目（行级校验失败 / 空年度无法新增） */
export interface ErrorItem extends PreviewRowItem {
  fields: RowError[];
}

/** 预览结果（精简响应：汇总 + 精简清单；无服务端状态） */
export interface ImportPreviewResult {
  summary: { created: number; pendingChoice: number; skipped: number; conflict: number; error: number };
  created: PreviewRowItem[];
  pendingChoice: PendingChoiceItem[];
  conflicts: ConflictItem[];
  errors: ErrorItem[];
}

/** 确认结果 */
export interface ImportConfirmResult {
  summary: { created: number; overwritten: number; skipped: number };
}

/** 行匹配结果（内部） */
interface MatchedRow {
  input: ProjectRowInput;
  status: 'NEW' | 'CHOICE' | 'SKIP' | 'DELETED' | 'AMBIGUOUS' | 'YEAR_REQUIRED' | 'DUPLICATE';
  target?: Project;
  conflictReason?: string;
  errors: RowError[];
  businessKey: string;
}

/** 构造只有项目名称的空年度数据行输入（未知分组名重判后的数据行形态） */
function emptyRowInput(rowNumber: number, name: string): ProjectRowInput {
  return {
    rowNumber,
    name,
    year: null,
    groupName: null,
    completenessDocs: [],
    regionName: null,
    progressName: null,
    partyA: null,
    generalContractor: null,
    managementFee: null,
    subcontractors: [],
    contractStartDate: null,
    contractEndDate: null,
    contractAmount: null,
    paymentNode: null,
    tentativeAuditedAmount: null,
    invoices: [],
    receipts: [],
    remark: null,
    settlement: null,
    subcontractPayments: [],
    miscExpense: null,
  };
}

/** 字典名 → 字典项解析上下文 */
interface DictContext {
  regions: Map<string, { id: number; name: string; status: string }>;
  progresses: Map<string, { id: number; name: string; semantic: 'TENTATIVE' | 'AUDITED' | null; status: string }>;
  categories: Map<string, { id: number; name: string; status: string }>;
  completeness: Map<string, { id: number; name: string; status: string }>;
}

/**
 * 利润分析 Excel 导入服务（fin PRD §4）。
 *
 * - 预览：当前请求内读取/校验并生成“新增/待选择/跳过/冲突/错误”预览，不写入正式表；
 * - 确认：重新解析同一文件，以重新解析的行号解释选择映射，dataRevision 条件更新
 *   防预览后变化（IMPORT_PREVIEW_STALE），整批全有或全无；
 * - 单用户并发（与导出不同 Redis 键）、120 秒固定总时限、请求取消传播；
 * - 原文件不上传 OSS/不写 PostgreSQL/Redis/磁盘，请求结束不保留文件内容。
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly workerPool: XlsxWorkerPool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * 取得单用户导入并发占用（fin PRD §4：认证授权后、读取上传体前取得）。
   *
   * HTTP 路径由 ExcelImportLockGuard 在 Multer 之前获取并写入请求上下文，
   * 此处直接复用同一句柄（不重复获取）；直接调用（测试/内部任务）则自行获取。
   * 占用需在响应结束/失败/超时后释放（守卫兜底 + 调用方 finally）。
   */
  async acquireImportLock(userId: number): Promise<() => Promise<void>> {
    const held = getRequestImportLockRelease();
    if (held) {
      return held;
    }
    const lockKey = redisKey(REDIS_NAMESPACE.LOCK, 'fin-import', userId);
    const token = randomUUID();
    const acquired = await this.redis.set(lockKey, token, 'EX', IMPORT_LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') {
      throw new BusinessException(exportErrors.IMPORT_ALREADY_RUNNING);
    }
    let released = false;
    const release = async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
    };
    return release;
  }

  /**
   * 导入预览（解析 + 匹配；不写正式表）。
   *
   * @param operator 操作人
   * @param buffer 上传文件内容（≤ 20 MiB）
   * @param signal 取消信号
   * @returns 精简预览响应
   */
  async preview(operator: FinOperationLogOperator, buffer: Buffer, signal?: AbortSignal): Promise<ImportPreviewResult> {
    const release = await this.acquireImportLock(operator.id);
    try {
      const checkTimeout = makeImportTimeoutCheck(signal);
      const parsed = await this.parseWithWorker(buffer, signal);
      checkTimeout();
      const result = await this.matchRows(parsed.rows, parsed.errors);
      checkTimeout();
      return result;
    } finally {
      await release();
    }
  }

  /**
   * 导入确认（重新解析同一文件 + 选择映射校验 + 集合化批量写入；全有或全无）。
   *
   * @param operator 操作人
   * @param buffer 上传文件内容（与预览同一文件）
   * @param choices 选择映射（Excel 行号 → 覆盖/跳过）
   * @param idempotencyKey 幂等键（确认接口幂等）
   * @param signal 取消信号
   * @returns 确认结果
   */
  async confirm(
    operator: FinOperationLogOperator,
    buffer: Buffer,
    choices: ImportChoiceDto[],
    idempotencyKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<ImportConfirmResult> {
    const release = await this.acquireImportLock(operator.id);
    try {
      // 重新解析同一文件，以重新解析的行号解释选择映射（文件被替换导致行号错位时由 dataRevision 兜底）
      const checkTimeout = makeImportTimeoutCheck(signal);
      const parsed = await this.parseWithWorker(buffer, signal);
      checkTimeout();
      const preview = await this.matchRows(parsed.rows, parsed.errors);
      checkTimeout();
      const { inputs } = await this.buildRowInputsWithGroups(parsed.rows, parsed.errors);
      checkTimeout();
      return executeIdempotentOperation(this.prisma.client, {
        operator,
        feature: FINANCE_MAINTAIN_FUNCTION_CODE,
        scope: 'fin.import.confirm',
        idempotencyKey,
        // 指纹纳入文件内容：同键 + 同 choices + 不同文件 → 409（M17，主 PRD §3.3）。
        // 只传 sha256 十六进制串，避免 canonicalize 展开 Buffer 索引属性造成超大序列化。
        fingerprint: fingerprintPayload({ choices, fileSha256: createHash('sha256').update(buffer).digest('hex') }),
        run: async (tx) => {
          const result = await this.applyImport(tx, operator, inputs, preview, choices, checkTimeout);
          // 终末检查点：applyImport 最后一个检查点在审计 createMany 之后，而幂等日志写入与
          // 事务提交之间还有一次 DB 往返——取消恰落此窗口时事务仍会提交；beforeCommit
          // 把检查点延伸到幂等日志写入与 commit 之前（fin PRD §4）
          checkTimeout();
          return {
            result,
            actionType: 'UPDATE' as const,
            summary: `在利润分析中导入了 ${result.summary.created + result.summary.overwritten} 个项目（新增 ${result.summary.created}、覆盖 ${result.summary.overwritten}、跳过 ${result.summary.skipped}）`,
          };
        },
        // 提交前最终检查点：覆盖幂等日志写入与事务提交之间的最后窗口
        beforeCommit: () => checkTimeout(),
      });
    } finally {
      await release();
    }
  }

  /** worker 解析（超时/取消传播） */
  private async parseWithWorker(buffer: Buffer, signal?: AbortSignal): Promise<{ rows: ParsedRow[]; errors: RowError[] }> {
    const transfer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const result = await this.workerPool.run<{ rows: ParsedRow[]; errors: RowError[] } | ParseFailure>(
      'parse',
      { buffer: transfer },
      [transfer],
      signal,
    );
    if ('kind' in result) {
      switch (result.kind) {
        case 'ROW_LIMIT':
          throw new BusinessException(financeErrors.IMPORT_ROW_LIMIT_EXCEEDED);
        case 'ARCHIVE_LIMIT':
          throw new BusinessException(financeErrors.IMPORT_ARCHIVE_LIMIT_EXCEEDED);
        case 'SHEET_INVALID':
          throw new BusinessException(financeErrors.IMPORT_SHEET_INVALID);
        case 'ZIP_CORRUPT':
          throw new BusinessException(financeErrors.IMPORT_SHEET_INVALID, { fields: [{ field: 'file', reason: result.reason }] });
      }
    }
    return result;
  }

  /** 查询现有业务分类名称集合并构建行输入（分组行识别依赖分类字典） */
  private async buildRowInputsWithGroups(rows: ParsedRow[], rowErrors: RowError[]): Promise<{ inputs: ProjectRowInput[]; errors: RowError[] }> {
    const categories = await this.prisma.client.financeDictItem.findMany({
      where: { dictType: 'BIZ_CATEGORY' },
      select: { name: true },
    });
    const validGroups = new Set(categories.map((category) => normalizeProjectName(category.name)));
    validGroups.add(normalizeProjectName(UNCLASSIFIED_GROUP));
    return this.buildRowInputs(rows, rowErrors, validGroups);
  }

  /**
   * 行 → 结构化输入（行级错误收集；分组上下文沿用最近分组行）。
   *
   * @param rows 解析行
   * @param rowErrors 解析期行级错误
   * @param validGroupNames 现有业务分类的规范化名称集合（含“未分类”）：
   *   单 B 列行被解析为分组行，但名称不匹配现有分类时重新解释为空年度数据行
   *   （避免手写文件中只有项目名称的行被误当分组；fin PRD §4 空年度行兼容）
   */
  private buildRowInputs(
    rows: ParsedRow[],
    rowErrors: RowError[],
    validGroupNames?: ReadonlySet<string>,
  ): { inputs: ProjectRowInput[]; errors: RowError[] } {
    const inputs: ProjectRowInput[] = [];
    const errors: RowError[] = [...rowErrors];
    let groupContext: string | null = null;
    for (const row of rows) {
      if (row.kind === 'group') {
        const groupName = row.groupName === UNCLASSIFIED_GROUP ? null : (row.groupName ?? null);
        const isKnownGroup = validGroupNames
          ? groupName === null || validGroupNames.has(normalizeProjectName(groupName))
          : true;
        if (isKnownGroup) {
          groupContext = groupName;
          continue;
        }
        // 未知分类名：该行实际是只有项目名称的空年度数据行（不猜测年份）
        const name = row.groupName as string;
        inputs.push({ ...emptyRowInput(row.rowNumber, name) });
        continue;
      }
      if (row.kind === 'subtotal' || row.kind === 'empty') {
        continue;
      }
      const yearText = row.cells[COL.YEAR - 1];
      const year = yearText === null || yearText === '' ? null : Number(yearText);
      const name = row.cells[COL.NAME - 1]?.trim() ?? '';
      inputs.push({
        rowNumber: row.rowNumber,
        name,
        year,
        groupName: groupContext,
        completenessDocs: splitMultiValue(row.cells[COL.COMPLETENESS - 1] ?? '', true),
        regionName: row.cells[COL.REGION - 1]?.trim() || null,
        progressName: row.cells[COL.PROGRESS - 1]?.trim() || null,
        partyA: row.cells[COL.PARTY_A - 1]?.trim() || null,
        generalContractor: row.cells[COL.GENERAL_CONTRACTOR - 1]?.trim() || null,
        managementFee: row.cells[COL.MANAGEMENT_FEE - 1]?.trim() || null,
        subcontractors: splitMultiValue(row.cells[COL.SUBCONTRACTORS - 1] ?? '', true),
        contractStartDate: row.cells[COL.CONTRACT_START - 1]?.trim() || null,
        contractEndDate: row.cells[COL.CONTRACT_END - 1]?.trim() || null,
        contractAmount: row.cells[COL.CONTRACT_AMOUNT - 1]?.trim() || null,
        paymentNode: row.cells[COL.PAYMENT_NODE - 1]?.trim() || null,
        tentativeAuditedAmount: row.cells[COL.TENTATIVE_AUDITED - 1]?.trim() || null,
        invoices: splitMultiValue(row.cells[COL.INVOICES - 1] ?? '', true),
        receipts: splitMultiValue(row.cells[COL.RECEIPTS - 1] ?? '', true),
        remark: row.cells[COL.REMARK - 1]?.trim() || null,
        settlement: row.cells[COL.SETTLEMENT - 1]?.trim() || null,
        subcontractPayments: splitMultiValue(row.cells[COL.SUBCONTRACT_PAYMENTS - 1] ?? '', true),
        miscExpense: row.cells[COL.MISC_EXPENSE - 1]?.trim() || null,
      });
    }
    return { inputs, errors };
  }

  /**
   * 匹配：规范化键集合化查询；带年度行按业务键精确匹配，空年度行按名称唯一匹配。
   * 同时执行文件内重复判重与行级业务错误收集。
   */
  private async matchRows(rows: ParsedRow[], rowErrors: RowError[]): Promise<ImportPreviewResult> {
    const { inputs, errors } = await this.buildRowInputsWithGroups(rows, rowErrors);
    if (inputs.length === 0) {
      // 无数据行：仅返回行级解析错误（按行包装为错误条目）
      return {
        summary: { created: 0, pendingChoice: 0, skipped: 0, conflict: 0, error: errors.length },
        created: [],
        pendingChoice: [],
        conflicts: [],
        errors: errors.map((error) => ({
          rowNumber: error.rowNumber,
          name: '',
          year: null,
          bizCategory: null,
          fields: [error],
        })),
      };
    }

    // 集合化查询：全部带年度键（业务键+年度）+ 全部名称（空年度行按名称匹配）
    const keyed = inputs.filter((input) => input.year !== null);
    const nameOnly = inputs.filter((input) => input.year === null);
    const names = [...new Set([...keyed, ...nameOnly].map((input) => normalizeProjectName(input.name)))];
    const keyClauses: Array<{ businessKey: string; year: number }> = keyed.map((input) => ({
      businessKey: normalizeProjectName(input.name),
      year: input.year as number,
    }));
    // keyClauses 为空时（全空年度行输入）必须省略 AND 分支：Prisma 的 AND: [] 恒真，
    // 会令整个 OR 恒真导致 findMany 无过滤全表读取（M18 复核修复）
    const [projects] = await Promise.all([
      this.prisma.client.project.findMany({
        where: {
          OR: [...(keyClauses.length > 0 ? [{ AND: keyClauses }] : []), ...(names.length > 0 ? [{ businessKey: { in: names } }] : [])],
        },
        orderBy: { id: 'asc' },
      }),
    ]);
    const byKey = new Map<string, Project[]>();
    const byName = new Map<string, Project[]>();
    for (const project of projects) {
      const key = `${project.businessKey}\u0000${project.year}`;
      const bucket = byKey.get(key) ?? [];
      bucket.push(project);
      byKey.set(key, bucket);
      const nameBucket = byName.get(project.businessKey) ?? [];
      nameBucket.push(project);
      byName.set(project.businessKey, nameBucket);
    }

    const matched: MatchedRow[] = [];
    const seenProjectIds = new Set<number>();
    const seenKeys = new Set<string>();

    for (const input of inputs) {
      const businessKey = normalizeProjectName(input.name);
      let status: MatchedRow['status'] = 'NEW';
      let target: Project | undefined;
      let conflictReason: string | undefined;

      if (input.year !== null) {
        // 带年度行：业务键精确匹配
        const key = `${businessKey}\u0000${input.year}`;
        const candidates = byKey.get(key) ?? [];
        if (candidates.some((p) => p.deletedAt === null)) {
          status = 'CHOICE';
          target = candidates.find((p) => p.deletedAt === null);
        } else if (candidates.length > 0) {
          status = 'DELETED';
          conflictReason = '项目已被删除，请进入已删除项目视图恢复或改名';
        } else if (seenKeys.has(key)) {
          status = 'DUPLICATE';
          conflictReason = '同一文件中存在重复项目行（同一名称与年度）';
        }
        seenKeys.add(key);
      } else {
        // 空年度行：按名称唯一匹配（不猜测当前年份）
        const candidates = byName.get(businessKey) ?? [];
        const active = candidates.filter((p) => p.deletedAt === null);
        const deleted = candidates.filter((p) => p.deletedAt !== null);
        if (active.length === 1 && deleted.length === 0) {
          status = 'CHOICE';
          target = active[0];
        } else if (active.length === 0 && deleted.length === 0) {
          status = 'YEAR_REQUIRED';
          conflictReason = '新增项目必须提供年度';
        } else if (active.length > 1) {
          status = 'AMBIGUOUS';
          conflictReason = '存在多条同名跨年度记录，无法匹配，请补充年度';
        } else {
          status = 'DELETED';
          conflictReason = '项目已被删除或存在同名歧义，请补充年度后重试';
        }
      }

      // 文件内重复（最终指向同一项目）
      if (target && seenProjectIds.has(target.id)) {
        status = 'DUPLICATE';
        conflictReason = '同一文件中多行指向同一项目（重复覆盖）';
      }
      if (target) {
        seenProjectIds.add(target.id);
      }

      matched.push({ input, status, target, conflictReason, errors: [], businessKey });
    }

    // 覆盖数据丢失警告判定（fin PRD §4）：仅目标项目存在任何带日期或单笔备注的明细时警告。
    // 集合化查询三张明细表，避免逐项目 N+1。
    const choiceTargetIds = [...new Set(matched.filter((m) => m.status === 'CHOICE' && m.target).map((m) => (m.target as Project).id))];
    const lossyProjectIds = new Set<number>();
    if (choiceTargetIds.length > 0) {
      const [inv, rec, pay] = await Promise.all([
        this.prisma.client.invoice.findMany({
          where: { projectId: { in: choiceTargetIds }, OR: [{ occurredDate: { not: null } }, { remark: { not: null } }] },
          select: { projectId: true },
        }),
        this.prisma.client.receipt.findMany({
          where: { projectId: { in: choiceTargetIds }, OR: [{ occurredDate: { not: null } }, { remark: { not: null } }] },
          select: { projectId: true },
        }),
        this.prisma.client.subcontractPayment.findMany({
          where: { projectId: { in: choiceTargetIds }, OR: [{ occurredDate: { not: null } }, { remark: { not: null } }] },
          select: { projectId: true },
        }),
      ]);
      for (const row of [...inv, ...rec, ...pay]) {
        lossyProjectIds.add(row.projectId);
      }
    }
    return this.buildPreview(matched, errors, lossyProjectIds);
  }

  /** 组装精简预览响应 */
  private buildPreview(matched: MatchedRow[], rowErrors: RowError[], lossyProjectIds: ReadonlySet<number>): ImportPreviewResult {
    const created: PreviewRowItem[] = [];
    const pendingChoice: PendingChoiceItem[] = [];
    const conflicts: ConflictItem[] = [];
    const errors: ErrorItem[] = [];
    // 行级错误按行号收集数组：同一行多个字段错误全部返回（fin PRD §4 字段级安全错误）
    const errorsByRow = new Map<number, RowError[]>();
    for (const error of rowErrors) {
      const list = errorsByRow.get(error.rowNumber) ?? [];
      list.push(error);
      errorsByRow.set(error.rowNumber, list);
    }

    for (const item of matched) {
      const { input } = item;
      const preview: PreviewRowItem = { rowNumber: input.rowNumber, name: input.name, year: input.year, bizCategory: input.groupName };
      // 行级校验错误：整行不参与新增/覆盖选择，只进错误列表（fin PRD §4：任一错误不得产生部分写入）
      const rowErrorsHere = errorsByRow.get(input.rowNumber) ?? [];
      if (item.status === 'NEW' || item.status === 'CHOICE') {
        if (rowErrorsHere.length > 0) {
          errors.push({ ...preview, fields: rowErrorsHere });
          continue;
        }
        if (item.status === 'NEW') {
          created.push(preview);
        } else if (item.target) {
          // 覆盖丢失明细日期/备注警告：仅目标项目存在任何带日期或备注的明细时警告
          pendingChoice.push({
            ...preview,
            projectId: item.target.id,
            dataRevision: item.target.dataRevision,
            dataLossWarning: lossyProjectIds.has(item.target.id),
          });
        }
        continue;
      }
      if (item.status === 'DELETED' || item.status === 'AMBIGUOUS' || item.status === 'DUPLICATE' || item.status === 'YEAR_REQUIRED') {
        conflicts.push({
          ...preview,
          status: item.status === 'DELETED' ? 'DELETED' : item.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'DUPLICATE',
          reason: item.conflictReason ?? '',
        });
      } else {
        errors.push({ ...preview, fields: item.errors });
      }
      // 冲突行同时存在行级错误时并入错误列表（整行仍按冲突处理，不参与写入）
      if (rowErrorsHere.length > 0) {
        errors.push({ ...preview, fields: rowErrorsHere });
      }
    }

    return {
      summary: {
        created: created.length,
        pendingChoice: pendingChoice.length,
        skipped: 0,
        conflict: conflicts.length,
        error: errors.length,
      },
      created,
      pendingChoice,
      conflicts,
      errors,
    };
  }

  /** 确认写入（集合化批量；同一事务全有或全无） */
  private async applyImport(
    tx: Prisma.TransactionClient,
    operator: FinOperationLogOperator,
    inputs: ProjectRowInput[],
    preview: ImportPreviewResult,
    choices: ImportChoiceDto[],
    checkTimeout: () => void,
  ): Promise<ImportConfirmResult> {
    if (inputs.length === 0) {
      return { summary: { created: 0, overwritten: 0, skipped: 0 } };
    }
    const choiceByRow = new Map(choices.map((choice) => [choice.rowNumber, choice]));
    const inputByRow = new Map(inputs.map((input) => [input.rowNumber, input]));
    const createdRows = new Set(preview.created.map((row) => row.rowNumber));
    const pendingRows = new Map(preview.pendingChoice.map((row) => [row.rowNumber, row]));

    const dicts = await loadDictContext(tx);

    // 选择映射校验：行号必须引用真实存在的项目行；覆盖行必须带 projectId/dataRevision；
    // 待选择行未提交选择默认跳过；新增行提交 SKIP 或未提交也跳过
    const toCreate: Array<{ input: ProjectRowInput; businessKey: string }> = [];
    const toOverwrite: Array<{ input: ProjectRowInput; businessKey: string; targetId: number; dataRevision: number }> = [];
    let skippedCount = 0;
    for (const input of inputs) {
      const businessKey = normalizeProjectName(input.name);
      if (createdRows.has(input.rowNumber)) {
        const choice = choiceByRow.get(input.rowNumber);
        if (choice && choice.decision !== 'SKIP') {
          toCreate.push({ input, businessKey });
        } else {
          skippedCount += 1;
        }
        continue;
      }
      const pending = pendingRows.get(input.rowNumber);
      if (pending) {
        const choice = choiceByRow.get(input.rowNumber);
        if (!choice || choice.decision === 'SKIP') {
          skippedCount += 1;
          continue;
        }
        if (choice.projectId === undefined || choice.dataRevision === undefined || choice.projectId !== pending.projectId) {
          throw new BusinessException(financeErrors.IMPORT_CONFIRM_MISMATCH);
        }
        toOverwrite.push({ input, businessKey, targetId: choice.projectId, dataRevision: choice.dataRevision });
      } else if (inputByRow.has(input.rowNumber)) {
        // 冲突/错误行：不参与写入（也不计跳过）
        continue;
      }
    }

    // 1. 新增：业务键必须仍不存在（含软删除占键；预览后创建/恢复 → 整批回滚）。
    // 集合化（fin PRD §4 禁止逐行查询+写入）：一次批量业务键校验 + createMany；
    // 校验兜底 P2002 无法定位行号，整体转 IMPORT_PREVIEW_STALE（预览后并发创建/恢复属极端窗口）。
    const createdIds: number[] = [];
    if (toCreate.length > 0) {
      checkTimeout();
      // 批量业务键冲突预检（含软删除占键）：一次往返替代逐行 findFirst
      const keyClashes = await tx.project.findMany({
        where: {
          OR: toCreate.map((item) => ({ businessKey: item.businessKey, year: item.input.year as number })),
        },
        select: { id: true, businessKey: true, year: true },
      });
      if (keyClashes.length > 0) {
        const clashKeys = new Set(keyClashes.map((row) => `${row.businessKey}:${row.year}`));
        throw new BusinessException(financeErrors.IMPORT_PREVIEW_STALE, {
          fields: toCreate
            .filter((item) => clashKeys.has(`${item.businessKey}:${item.input.year}`))
            .map((item) => ({ rowNumber: item.input.rowNumber, reason: '该业务键已在预览后被创建或恢复' })),
        });
      }
      checkTimeout();
      const createData: Prisma.ProjectUncheckedCreateInput[] = [];
      for (const item of toCreate) {
        if (item.input.year === null) {
          throw new BusinessException(financeErrors.IMPORT_YEAR_REQUIRED_FOR_NEW);
        }
        createData.push({
          ...(await buildProjectDataFromInput(tx, item.input, dicts)),
          year: item.input.year as number,
          createdBy: operator.id,
          updatedBy: operator.id,
        });
      }
      // 分批 createManyAndReturn（每批一条 SQL，保持集合化；批间 checkTimeout 供取消/超时检查点）
      try {
        for (let offset = 0; offset < createData.length; offset += CREATE_BATCH_SIZE) {
          const created = await tx.project.createManyAndReturn({
            data: createData.slice(offset, offset + CREATE_BATCH_SIZE),
            select: { id: true },
          });
          createdIds.push(...created.map((row) => row.id));
          checkTimeout();
        }
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new BusinessException(financeErrors.IMPORT_PREVIEW_STALE, {
            fields: [{ rowNumber: 0, reason: '业务键在写入瞬间被并发创建（预览已过期，请重新预览）' }],
          });
        }
        throw error;
      }
    }

    // 2. 覆盖：dataRevision 条件更新（预览后变化 → 整批回滚；缺数核对）。
    // 集合化：一次批量存在性/dataRevision 校验 + 明细快照批量读取/删除/重建；
    // updateMany 每行携带各自 dataRevision 条件（Prisma 单次仅一个 where），保留逐行条件更新。
    const overwriteDetail: Array<{ projectId: number; beforeDetails: ProjectDetailSnapshot; afterDetails: ProjectDetailSnapshot }> = [];
    if (toOverwrite.length > 0) {
      checkTimeout();
      const targetIds = toOverwrite.map((item) => item.targetId);
      const existingRows = await tx.project.findMany({ where: { id: { in: targetIds } } });
      const existingById = new Map(existingRows.map((row) => [row.id, row]));
      for (const item of toOverwrite) {
        const existing = existingById.get(item.targetId);
        if (!existing || existing.deletedAt !== null) {
          throw new BusinessException(financeErrors.IMPORT_PREVIEW_STALE, {
            fields: [{ rowNumber: item.input.rowNumber, reason: '目标项目不存在或已被删除' }],
          });
        }
        if (existing.dataRevision !== item.dataRevision) {
          throw new BusinessException(financeErrors.IMPORT_PREVIEW_STALE, {
            fields: [{ rowNumber: item.input.rowNumber, reason: '目标项目数据已在预览后变化' }],
          });
        }
      }
      // 批量读取覆盖前明细快照（一次往返替代逐行 3 次查询）
      const beforeById = await batchSnapshotDetails(tx, targetIds);
      // 逐行条件更新（dataRevision 每行不同，无法合并为单次 updateMany）
      for (const item of toOverwrite) {
        const existing = existingById.get(item.targetId) as Project;
        const data = await buildProjectDataFromInput(tx, item.input, dicts, existing);
        checkTimeout();
        const updated = await tx.project.updateMany({
          where: { id: item.targetId, dataRevision: item.dataRevision },
          data: { ...data, dataRevision: { increment: 1 }, updatedBy: operator.id },
        });
        if (updated.count !== 1) {
          throw new BusinessException(financeErrors.IMPORT_PREVIEW_STALE);
        }
      }
      checkTimeout();
      // 物理删除原明细并按上传顺序重建（Excel 只保存金额；日期/单笔备注清空，审计保留前后完整快照）
      await tx.invoice.deleteMany({ where: { projectId: { in: targetIds } } });
      await tx.receipt.deleteMany({ where: { projectId: { in: targetIds } } });
      await tx.subcontractPayment.deleteMany({ where: { projectId: { in: targetIds } } });
      await batchRebuildDetails(tx, toOverwrite.map((item) => ({ projectId: item.targetId, input: item.input })));
      // 批量读取覆盖后明细快照
      const afterById = await batchSnapshotDetails(tx, targetIds);
      for (const item of toOverwrite) {
        overwriteDetail.push({
          projectId: item.targetId,
          beforeDetails: beforeById.get(item.targetId) as ProjectDetailSnapshot,
          afterDetails: afterById.get(item.targetId) as ProjectDetailSnapshot,
        });
      }
    }

    checkTimeout();
    // 3. 审计（与业务变更同一事务；新增/覆盖/跳过逐项目记录）
    const operations: Prisma.ProjectOperationUncheckedCreateInput[] = [];
    for (const id of createdIds) {
      operations.push({
        projectId: id,
        operatorId: operator.id,
        operatorName: operator.name,
        action: 'IMPORT_CREATE',
        before: Prisma.DbNull,
        after: { source: 'Excel 导入' } as Prisma.InputJsonValue,
      });
    }
    for (const item of overwriteDetail) {
      operations.push({
        projectId: item.projectId,
        operatorId: operator.id,
        operatorName: operator.name,
        action: 'IMPORT_OVERWRITE',
        before: item.beforeDetails as unknown as Prisma.InputJsonValue,
        after: item.afterDetails as unknown as Prisma.InputJsonValue,
      });
    }
    for (const input of inputs) {
      const pending = pendingRows.get(input.rowNumber);
      // 跳过结果逐项目记录（fin PRD §4）：显式选择 SKIP 与未提交选择均记录，覆盖行除外
      if (pending && choiceByRow.get(input.rowNumber)?.decision !== 'OVERWRITE') {
        operations.push({
          projectId: pending.projectId,
          operatorId: operator.id,
          operatorName: operator.name,
          action: 'IMPORT_SKIP',
          before: Prisma.DbNull,
          after: { source: 'Excel 导入（跳过）' } as Prisma.InputJsonValue,
        });
      }
    }
    if (operations.length > 0) {
      await tx.projectOperation.createMany({ data: operations });
    }
    checkTimeout();

    return {
      summary: {
        created: createdIds.length,
        overwritten: toOverwrite.length,
        skipped: skippedCount + preview.summary.skipped,
      },
    };
  }
}

/** 项目明细快照（覆盖前/后的完整明细快照审计） */
interface ProjectDetailSnapshot {
  invoices: Array<{ amount: string; occurredDate: string | null; remark: string | null }>;
  receipts: Array<{ amount: string; occurredDate: string | null; remark: string | null }>;
  subcontractPayments: Array<{ amount: string; occurredDate: string | null; remark: string | null }>;
}

/** 批量读取多个项目全部明细快照（一次往返；按 projectId 分组，明细按 id 升序） */
async function batchSnapshotDetails(
  tx: Prisma.TransactionClient,
  projectIds: readonly number[],
): Promise<Map<number, ProjectDetailSnapshot>> {
  const fmt = (rows: Array<{ amount: Prisma.Decimal; occurredDate: Date | null; remark: string | null }>) =>
    rows.map((row) => ({
      amount: row.amount.toFixed(2),
      occurredDate: row.occurredDate ? formatCalendar(row.occurredDate) : null,
      remark: row.remark,
    }));
  const [invoices, receipts, payments] = await Promise.all([
    tx.invoice.findMany({ where: { projectId: { in: [...projectIds] } }, orderBy: { id: 'asc' } }),
    tx.receipt.findMany({ where: { projectId: { in: [...projectIds] } }, orderBy: { id: 'asc' } }),
    tx.subcontractPayment.findMany({ where: { projectId: { in: [...projectIds] } }, orderBy: { id: 'asc' } }),
  ]);
  const result = new Map<number, ProjectDetailSnapshot>();
  for (const projectId of projectIds) {
    result.set(projectId, {
      invoices: fmt(invoices.filter((row) => row.projectId === projectId)),
      receipts: fmt(receipts.filter((row) => row.projectId === projectId)),
      subcontractPayments: fmt(payments.filter((row) => row.projectId === projectId)),
    });
  }
  return result;
}

function formatCalendar(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** 批量重建明细（物理删除后按上传顺序重建；日期/备注为空；分批控制 SQL 参数量，同一事务） */
async function batchRebuildDetails(
  tx: Prisma.TransactionClient,
  items: Array<{ projectId: number; input: ProjectRowInput }>,
): Promise<void> {
  const toDecimal = (value: string): Prisma.Decimal => new Prisma.Decimal(value);
  const invoiceRows = items.flatMap(({ projectId, input }) =>
    input.invoices.map((amount) => ({ projectId, amount: toDecimal(amount), occurredDate: null, remark: null })),
  );
  const receiptRows = items.flatMap(({ projectId, input }) =>
    input.receipts.map((amount) => ({ projectId, amount: toDecimal(amount), occurredDate: null, remark: null })),
  );
  const paymentRows = items.flatMap(({ projectId, input }) =>
    input.subcontractPayments.map((amount) => ({ projectId, amount: toDecimal(amount), occurredDate: null, remark: null })),
  );
  await batchCreateMany(tx.invoice, invoiceRows);
  await batchCreateMany(tx.receipt, receiptRows);
  await batchCreateMany(tx.subcontractPayment, paymentRows);
}

/** 分批 createMany（每批 500 行；同一事务内不提前提交） */
async function batchCreateMany<T extends { projectId: number }>(
  delegate: { createMany: (args: { data: T[] }) => Promise<{ count: number }> },
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    if (batch.length > 0) {
      await delegate.createMany({ data: batch });
    }
  }
}

/** 加载字典上下文（地区/进度/分类/齐全度；含停用项供原引用往返） */
async function loadDictContext(tx: Prisma.TransactionClient): Promise<DictContext> {
  const items = await tx.financeDictItem.findMany();
  const context: DictContext = { regions: new Map(), progresses: new Map(), categories: new Map(), completeness: new Map() };
  for (const item of items) {
    const ref = { id: item.id, name: item.name, status: item.status };
    if (item.dictType === 'REGION') {
      context.regions.set(normalizeProjectName(item.name), ref);
    } else if (item.dictType === 'PROGRESS') {
      context.progresses.set(normalizeProjectName(item.name), { ...ref, semantic: item.semantic });
    } else if (item.dictType === 'BIZ_CATEGORY') {
      context.categories.set(normalizeProjectName(item.name), ref);
    } else {
      context.completeness.set(normalizeProjectName(item.name), ref);
    }
  }
  return context;
}

/** 解析字典引用（名称 → 字典项；新增仅启用项；覆盖时停用项仅允许原引用往返） */
function resolveDictRef(
  name: string | null,
  map: Map<string, { id: number; name: string; status: string }>,
  currentId: number | null,
  fieldLabel: string,
  rowNumber: number,
  allowDisabledRetention: boolean,
): { id: number; name: string } | null {
  if (name === null) {
    return null;
  }
  const item = map.get(normalizeProjectName(name));
  if (!item) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
      fields: [{ rowNumber, field: fieldLabel, reason: `字典项“${name}”不存在` }],
    });
  }
  if (item.status === 'DISABLED' && !(allowDisabledRetention && item.id === currentId)) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
      fields: [{ rowNumber, field: fieldLabel, reason: `字典项“${name}”已停用，不能选择` }],
    });
  }
  return { id: item.id, name: item.name };
}

/** 构建项目写入数据（新增/覆盖共用；字典校验 + 快照 + 明细字段；形状对 create/update 均兼容） */
async function buildProjectDataFromInput(
  tx: Prisma.TransactionClient,
  input: ProjectRowInput,
  dicts: DictContext,
  existing?: Project,
): Promise<Prisma.ProjectUncheckedCreateInput> {
  const businessKey = normalizeProjectName(input.name);
  // 资料齐全度（多选；覆盖时停用项仅保留原引用）
  const currentDocs = Array.isArray(existing?.completenessDocs)
    ? (existing?.completenessDocs as Array<{ id: number }>)
    : [];
  const completeness = input.completenessDocs.map((name) => {
    const item = dicts.completeness.get(normalizeProjectName(name));
    if (!item) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: [{ rowNumber: input.rowNumber, field: '资料齐全度', reason: `字典项“${name}”不存在` }],
      });
    }
    if (item.status === 'DISABLED' && !currentDocs.some((doc) => doc.id === item.id)) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: [{ rowNumber: input.rowNumber, field: '资料齐全度', reason: `停用项“${name}”不能新增引用` }],
      });
    }
    return { id: item.id, name: item.name };
  });
  const region = resolveDictRef(input.regionName, dicts.regions, existing?.regionId ?? null, '地区', input.rowNumber, Boolean(existing));
  const progress = resolveDictRef(input.progressName, dicts.progresses, existing?.progressId ?? null, '项目进度', input.rowNumber, Boolean(existing));
  const category = resolveDictRef(input.groupName, dicts.categories, existing?.bizCategoryId ?? null, '业务分类', input.rowNumber, Boolean(existing));
  const progressItem = input.progressName ? dicts.progresses.get(normalizeProjectName(input.progressName)) : undefined;

  return {
    name: input.name,
    year: input.year ?? (existing?.year as number),
    businessKey,
    completenessDocs: completeness as unknown as Prisma.InputJsonValue,
    regionId: region?.id ?? null,
    regionName: region?.name ?? null,
    progressId: progress?.id ?? null,
    progressName: progress?.name ?? null,
    progressSemantic: progressItem?.semantic ?? 'TENTATIVE',
    bizCategoryId: category?.id ?? null,
    bizCategoryName: category?.name ?? null,
    partyA: input.partyA,
    generalContractor: input.generalContractor,
    managementFee: input.managementFee,
    subcontractors: input.subcontractors,
    contractStartDate: input.contractStartDate ? new Date(`${input.contractStartDate}T00:00:00Z`) : null,
    contractEndDate: input.contractEndDate ? new Date(`${input.contractEndDate}T00:00:00Z`) : null,
    contractAmount: input.contractAmount ? new Prisma.Decimal(input.contractAmount) : null,
    paymentNode: input.paymentNode,
    tentativeAuditedAmount: input.tentativeAuditedAmount ? new Prisma.Decimal(input.tentativeAuditedAmount) : null,
    settlement: input.settlement ? new Prisma.Decimal(input.settlement) : null,
    miscExpense: input.miscExpense ? new Prisma.Decimal(input.miscExpense) : null,
    remark: input.remark,
  };
}
