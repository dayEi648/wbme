import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, exportErrors, FINANCE_MAINTAIN_FUNCTION_CODE, type ProjectQueryDto } from '@wbme/contracts';
import type { Redis } from '@wbme/server';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { REDIS_CLIENT, REDIS_NAMESPACE, redisKey } from '@wbme/server';
import { Prisma, type Project } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { writeFinOperationLog, type FinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { normalizeProjectName } from '../../shared/name-normalize';
import { buildProjectTableQuery } from '../../shared/project-table-query';
import { calcProjectAutoFields } from '../../shared/project-calc';
import { type ExportProjectRow, type ExportSubtotal } from './export-builder';
import { XlsxWorkerPool } from './xlsx-worker-pool';

/** 导出总时限（毫秒）：120 秒（与平台通用导出一致） */
const EXPORT_TIMEOUT_MS = 120_000;

/** 导出锁 TTL（比总时限多 30s） */
const EXPORT_LOCK_TTL_SECONDS = Math.ceil(EXPORT_TIMEOUT_MS / 1000) + 30;

/** 释放锁 Lua：仅当锁值仍为本请求令牌时才删除（防旧请求误删新请求锁） */
const RELEASE_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/** 默认导出行数上限（平台设置 export.max.rows 缺省；主 PRD §10.3） */
const DEFAULT_EXPORT_MAX_ROWS = 100_000;

/** 读取批大小（键集分页） */
const FETCH_BATCH = 500;

/** 导出数据范围 */
export type ExportScope = 'all' | 'filtered';

/**
 * 利润分析固定模板导出服务（fin PRD §4 / 主 PRD §10.3）。
 *
 * - 导出所有/导出已筛选（不受当前页分页影响）；REPEATABLE READ 一致性快照内
 *   键集分批读取，稳定排序（真实业务分类配置顺序 → 未分类最后 → 年度升序 → 项目 ID 升序）；
 * - 与平台通用导出共用同一用户并发锁（同一用户同时最多 1 个导出）；120 秒总时限；
 * - 工作簿生成在 CPU 工作池；响应中断/失败不留下文件；导出成功后写 EXPORT 操作日志。
 */
@Injectable()
export class ExportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly workerPool: XlsxWorkerPool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * 执行利润分析导出。
   *
   * @param operator 操作人
   * @param res HTTP 响应
   * @param scope 数据范围（all=权限范围内全部未删除；filtered=当前筛选条件）
   * @param query 筛选参数（filtered 时生效）
   * @param signal 取消信号
   */
  async export(
    operator: FinOperationLogOperator,
    res: Response,
    scope: ExportScope,
    query: ProjectQueryDto,
    signal?: AbortSignal,
  ): Promise<void> {
    const lockKey = redisKey(REDIS_NAMESPACE.LOCK, 'export', operator.id);
    const lockToken = randomUUID();
    const acquired = await this.redis.set(lockKey, lockToken, 'EX', EXPORT_LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') {
      throw new BusinessException(exportErrors.EXPORT_ALREADY_RUNNING);
    }
    const started = Date.now();
    const checkTimeout = (): void => {
      if (Date.now() - started > EXPORT_TIMEOUT_MS) {
        throw new BusinessException(exportErrors.EXPORT_TIMEOUT);
      }
    };
    try {
      // 行数上限：平台设置 export.max.rows（跨 schema 只读视图；快照读取，修改不追溯）
      const maxRows = await this.readExportMaxRows();

      const filename = '工程合同与利润分析.xlsx';
      const groups = await this.prisma.client.$transaction(
        async (tx) => {
          const total = await this.countRows(tx, scope, query);
          checkTimeout();
          if (total > maxRows) {
            throw new BusinessException(exportErrors.ROW_LIMIT_EXCEEDED, {
              actualRows: total,
              limit: maxRows,
            });
          }
          // 业务分类配置顺序（字典 sort/id 升序）→ 未分类最后
          const categories = await tx.financeDictItem.findMany({
            where: { dictType: 'BIZ_CATEGORY' },
            orderBy: [{ sort: 'asc' }, { id: 'asc' }],
          });
          checkTimeout();
          const categoryOrder = new Map(categories.map((category, index) => [category.id, index]));

          // 键集分批读取（项目 ID 升序；分类顺序、年度排序在内存完成）
          const rows: Array<{ project: Project; index: number }> = [];
          let lastId = 0;
          for (;;) {
            checkTimeout();
            const batch = await tx.project.findMany({
              where: this.buildWhere(scope, query, lastId),
              orderBy: { id: 'asc' },
              take: FETCH_BATCH,
            });
            if (batch.length === 0) {
              break;
            }
            batch.forEach((project, offset) => rows.push({ project, index: lastId + offset }));
            lastId = (batch[batch.length - 1] as Project).id;
            if (batch.length < FETCH_BATCH) {
              break;
            }
          }
          checkTimeout();

          // 明细集合化加载（同快照内）
          const ids = rows.map((row) => row.project.id);
          const [invoices, receipts, payments] = await Promise.all([
            tx.invoice.findMany({ where: { projectId: { in: ids } }, orderBy: { id: 'asc' } }),
            tx.receipt.findMany({ where: { projectId: { in: ids } }, orderBy: { id: 'asc' } }),
            tx.subcontractPayment.findMany({ where: { projectId: { in: ids } }, orderBy: { id: 'asc' } }),
          ]);
          const bucket = <T extends { projectId: number }>(list: readonly T[]): Map<number, T[]> => {
            const map = new Map<number, T[]>();
            for (const item of list) {
              const group = map.get(item.projectId) ?? [];
              group.push(item);
              map.set(item.projectId, group);
            }
            return map;
          };
          const invoiceMap = bucket(invoices);
          const receiptMap = bucket(receipts);
          const paymentMap = bucket(payments);

          // 内存稳定排序：分类配置顺序 → 未分类最后 → 年度升序 → 项目 ID 升序
          const exportRows: ExportProjectRow[] = rows.map(({ project }) => {
            const auto = calcProjectAutoFields(project, {
              invoices: invoiceMap.get(project.id) ?? [],
              receipts: receiptMap.get(project.id) ?? [],
              subcontractPayments: paymentMap.get(project.id) ?? [],
            });
            const fmtDate = (date: Date | null): string =>
              date ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}` : '';
            const fmtDetail = (rows: readonly { amount: Prisma.Decimal }[]) => rows.map((row) => row.amount.toFixed(2)).join('\n');
            return {
              projectId: project.id,
              bizCategoryId: project.bizCategoryId,
              bizCategoryName: project.bizCategoryName,
              name: project.name,
              year: project.year,
              completenessDocs: (Array.isArray(project.completenessDocs) ? project.completenessDocs : [])
                .map((doc) => (doc as { name: string }).name)
                .join('\n'),
              regionName: project.regionName ?? '',
              progressName: project.progressName ?? '',
              partyA: project.partyA ?? '',
              generalContractor: project.generalContractor ?? '',
              managementFee: project.managementFee ?? '',
              subcontractors: project.subcontractors.join('\n'),
              contractStartDate: fmtDate(project.contractStartDate),
              contractEndDate: fmtDate(project.contractEndDate),
              contractAmount: project.contractAmount === null ? '' : project.contractAmount.toFixed(2),
              paymentNode: project.paymentNode ?? '',
              tentativeAuditedAmount: project.tentativeAuditedAmount === null ? '' : project.tentativeAuditedAmount.toFixed(2),
              semantic: project.progressSemantic ?? 'TENTATIVE',
              invoices: fmtDetail(invoiceMap.get(project.id) ?? []),
              receipts: fmtDetail(receiptMap.get(project.id) ?? []),
              subcontractPayments: fmtDetail(paymentMap.get(project.id) ?? []),
              totalInvoiced: auto.totalInvoiced,
              totalReceived: auto.totalReceived,
              remark: project.remark ?? '',
              remainingUninvoiced: auto.remainingUninvoiced,
              remainingUnreceived: auto.remainingUnreceived,
              settlement: project.settlement === null ? '' : project.settlement.toFixed(2),
              miscExpense: project.miscExpense === null ? '' : project.miscExpense.toFixed(2),
              totalSubcontractPaid: auto.totalSubcontractPaid,
              equity: auto.equity,
              grossMargin: auto.grossMargin,
            };
          });
          // 分类排序：真实业务分类配置顺序（字典 sort/id）→ 未分类最后；同分类内年度升序 → 项目 ID 升序
          const categoryIndex = (row: ExportProjectRow): number =>
            row.bizCategoryId === null ? Number.MAX_SAFE_INTEGER : (categoryOrder.get(row.bizCategoryId) ?? Number.MAX_SAFE_INTEGER - 1);
          exportRows.sort((a, b) => {
            const diff = categoryIndex(a) - categoryIndex(b);
            if (diff !== 0) return diff;
            if (a.year !== b.year) return a.year - b.year;
            return a.projectId - b.projectId;
          });

          // 分组：真实分类配置顺序 → 未分类最后；每组生成小计
          const groupKeys = [...new Set(exportRows.map((row) => row.bizCategoryName ?? null))];
          const groups = groupKeys.map((groupName) => {
            const groupRows = exportRows.filter((row) => (row.bizCategoryName ?? null) === groupName);
            const subtotal = calcSubtotal(groupRows);
            return { bizCategoryName: groupName, rows: groupRows, subtotal };
          });
          checkTimeout();

          // 工作簿生成（CPU 密集 → 工作池；快照数据在内存中随任务传递）
          const result = await this.workerPool.run<Buffer | { buffer: ArrayBuffer }>(
            'build',
            { groups },
            [],
            signal,
          );
          return { groups, buffer: unwrapBuildBuffer(result) };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: EXPORT_TIMEOUT_MS + 10_000 },
      );

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.end(groups.buffer);
      // 导出成功（服务端完成文件生成并正常结束响应）后写成功操作日志（主 PRD §3.3）
      await this.writeExportLog(operator, scope);
    } catch (error) {
      // 响应头已发送时（传输中断）不重写响应；其余异常按统一错误结构返回
      if (!res.headersSent) {
        throw error;
      }
    } finally {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, lockToken);
    }
  }

  /** 读平台设置 export.max.rows（经 backstage.platform_settings 只读视图；缺省 100000） */
  private async readExportMaxRows(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<Array<{ value: string }>>`
      SELECT value FROM backstage.platform_settings WHERE key = 'export.max.rows' LIMIT 1
    `;
    const value = Number(rows[0]?.value);
    return Number.isInteger(value) && value > 0 && value <= 200_000 ? value : DEFAULT_EXPORT_MAX_ROWS;
  }

  /** 行数统计（与数据读取同一快照） */
  private async countRows(tx: Prisma.TransactionClient, scope: ExportScope, query: ProjectQueryDto): Promise<number> {
    return tx.project.count({ where: this.buildWhere(scope, query, 0) });
  }

  /** 筛选条件（导出只含未删除项目；filtered 应用筛选参数；lastId 用于键集分页） */
  private buildWhere(scope: ExportScope, query: ProjectQueryDto, lastId: number): Prisma.ProjectWhereInput {
    const where: Prisma.ProjectWhereInput = { deletedAt: null };
    if (lastId > 0) {
      where.id = { gt: lastId };
    }
    if (scope === 'filtered') {
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
      if (tableQuery.where) {
        return { AND: [where, tableQuery.where as Prisma.ProjectWhereInput] };
      }
    }
    return where;
  }

  /** 导出成功操作日志（服务端完成文件生成并正常结束响应后；主 PRD §3.3） */
  private async writeExportLog(operator: FinOperationLogOperator, scope: ExportScope): Promise<void> {
    await writeFinOperationLog(this.prisma.client, {
      operator,
      feature: FINANCE_MAINTAIN_FUNCTION_CODE,
      actionType: 'EXPORT',
      summary: `在利润分析中${scope === 'all' ? '导出了全部' : '按筛选条件导出了'}项目利润分析`,
    });
  }
}

/**
 * 工作池结果统一为 Node Buffer（响应流输出要求）。
 *
 * 线程模式 worker 回传转移后的 `{ buffer: ArrayBuffer }` 包装（见 xlsx-worker.ts），
 * 内联模式（测试/OpenAPI 生成）直接返回 Buffer；此前未解包导致 `res.end` 收到普通对象
 * 抛 ERR_INVALID_ARG_TYPE、客户端下载空文件。
 *
 * @param result 工作池 build 任务返回
 * @returns 可写入响应的 Buffer
 */
export function unwrapBuildBuffer(result: Buffer | { buffer: ArrayBuffer }): Buffer {
  return Buffer.isBuffer(result) ? result : Buffer.from(result.buffer);
}

/** 分组小计（只汇总对应范围内数据；毛利率 = 组内汇总后计算） */
function calcSubtotal(rows: ExportProjectRow[]): ExportSubtotal {
  const add = (a: string, b: string): string => new Prisma.Decimal(a).plus(b).toFixed(2);
  let totalInvoiced = '0.00';
  let totalReceived = '0.00';
  let totalSubcontractPaid = '0.00';
  let equity = '0.00';
  for (const row of rows) {
    totalInvoiced = add(totalInvoiced, row.totalInvoiced);
    totalReceived = add(totalReceived, row.totalReceived);
    totalSubcontractPaid = add(totalSubcontractPaid, row.totalSubcontractPaid);
    equity = add(equity, row.equity);
  }
  const received = new Prisma.Decimal(totalReceived);
  const margin = received.isZero() ? null : new Prisma.Decimal(equity).div(received).toDecimalPlaces(8).toFixed();
  return { bizCategoryName: rows[0]?.bizCategoryName ?? null, totalInvoiced, totalReceived, totalSubcontractPaid, equity, grossMargin: margin };
}
