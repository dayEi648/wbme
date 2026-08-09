import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import { ExportService, unwrapBuildBuffer } from './export.service';
import { XlsxWorkerPool } from './xlsx-worker-pool';
import type { FinOperationLogOperator } from '../../shared/fin-operation-log.util';

/**
 * ExportService 导出响应链路单测（无数据库）。
 *
 * 回归点：工作池线程模式回传 `{ buffer: ArrayBuffer }` 包装，导出必须解包为 Node Buffer
 * 后才能 `res.end`（此前未解包，res.end 收到普通对象抛 ERR_INVALID_ARG_TYPE、客户端下载空文件，
 * 而内联模式测试路径返回裸 Buffer 掩盖了缺陷）。
 */
const OPERATOR: FinOperationLogOperator = { id: 880001, name: '导出测试员', departments: [] };

/** 最小项目主档（自动字段按空明细计算为 0） */
function sampleProject(): unknown {
  return {
    id: 1,
    bizCategoryId: null,
    bizCategoryName: null,
    name: '测试项目',
    year: 2026,
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
    progressSemantic: 'TENTATIVE',
    settlement: null,
    miscExpense: null,
    remark: null,
  };
}

function buildService(workerPool: Pick<XlsxWorkerPool, 'run'>): {
  service: ExportService;
  res: Response;
  mocks: { operationLogCreate: ReturnType<typeof vi.fn>; redisEval: ReturnType<typeof vi.fn> };
} {
  const operationLogCreate = vi.fn().mockResolvedValue({});
  const fakeTx = {
    project: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([sampleProject()]),
    },
    financeDictItem: { findMany: vi.fn().mockResolvedValue([]) },
    invoice: { findMany: vi.fn().mockResolvedValue([]) },
    receipt: { findMany: vi.fn().mockResolvedValue([]) },
    subcontractPayment: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const prisma = {
    client: {
      // 快照事务直接执行回调（隔离级别参数由实现传入，测试不校验）
      $transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx)),
      // 平台设置 export.max.rows 查询：无设置 → 默认 100000
      $queryRaw: vi.fn().mockResolvedValue([]),
      // 导出成功操作日志写在事务外（writeExportLog 用 this.prisma.client）
      operationLog: { create: operationLogCreate },
    },
  };
  const redis = {
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(1),
  };
  const res = { setHeader: vi.fn(), end: vi.fn() } as unknown as Response;
  const service = new ExportService(prisma as never, workerPool as never, redis as never);
  return { service, res, mocks: { operationLogCreate, redisEval: redis.eval } };
}

describe('ExportService 导出响应（工作池结果解包）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('线程模式：worker 返回 { buffer: ArrayBuffer } 包装，res.end 收到 Node Buffer', async () => {
    const transfer = new ArrayBuffer(8);
    new Uint8Array(transfer).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const workerPool = { run: vi.fn().mockResolvedValue({ buffer: transfer }) };
    const { service, res } = buildService(workerPool);

    await service.export(OPERATOR, res, 'all', {} as never);

    expect(workerPool.run).toHaveBeenCalledTimes(1);
    expect(workerPool.run.mock.calls[0]?.[0]).toBe('build');
    expect(res.end).toHaveBeenCalledTimes(1);
    const chunk = (res.end as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(Buffer.isBuffer(chunk)).toBe(true);
    expect([...chunk]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('内联模式：worker 直接返回 Buffer，原样进入 res.end', async () => {
    const buffer = Buffer.from('inline-xlsx');
    const workerPool = { run: vi.fn().mockResolvedValue(buffer) };
    const { service, res } = buildService(workerPool);

    await service.export(OPERATOR, res, 'all', {} as never);

    const chunk = (res.end as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(chunk).toBe(buffer);
  });

  it('导出成功后写 EXPORT 操作日志并释放用户并发锁', async () => {
    const workerPool = { run: vi.fn().mockResolvedValue({ buffer: new ArrayBuffer(4) }) };
    const { service, res, mocks } = buildService(workerPool);

    await service.export(OPERATOR, res, 'all', {} as never);

    expect(mocks.operationLogCreate).toHaveBeenCalledTimes(1);
    expect(mocks.operationLogCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { operatorId: OPERATOR.id, feature: expect.any(String), actionType: 'EXPORT' },
    });
    expect(mocks.redisEval).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});

describe('unwrapBuildBuffer', () => {
  it('内联 Buffer 原样返回', () => {
    const buffer = Buffer.from('abc');
    expect(unwrapBuildBuffer(buffer)).toBe(buffer);
  });

  it('线程模式包装对象解包为 Buffer', () => {
    const transfer = new ArrayBuffer(3);
    new Uint8Array(transfer).set([9, 8, 7]);
    const result = unwrapBuildBuffer({ buffer: transfer });
    expect(Buffer.isBuffer(result)).toBe(true);
    expect([...result]).toEqual([9, 8, 7]);
  });
});
