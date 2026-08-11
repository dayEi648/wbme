import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  REDIS_CLIENT,
  createRedisClient,
  createRequestContextMiddleware,
  createValidationPipe,
  setRequestUserId,
} from '@wbme/server';
import { ExcelController } from './excel.controller';
import { ExcelImportLockGuard } from './excel-import-lock.guard';
import { ExportService } from './export.service';
import { ImportService } from './import.service';
import { XlsxWorkerPool } from './xlsx-worker-pool';
import { loadTemplateWorkbook } from './export-builder';
import { WORKBOOK_SHEET_NAME } from './xlsx-template';
import { PrismaService } from '../../prisma.service';

/**
 * Excel 导入取消/超时集成测试（fin PRD §4；S7 复核缺口补测）。
 *
 * 目标：验证取消信号传播后确认事务**整批回滚、不产生任何部分写入**
 * （覆盖目标 dataRevision 不变、无新增行、无审计残留）。
 *
 * 覆盖场景：
 * 1. service 层：调用前已取消的 signal → 首个检查点抛错，未进入写入；
 * 2. service 层：执行中取消（大文件 + 定时 abort）→ 写入窗口内检查点抛错，事务回滚；
 * 3. HTTP 层：上传中断（请求体发送一半断开）→ handler 不执行，无写入；
 * 4. HTTP 层：响应关闭（完整发送后客户端断开）→ res 'close' 触发取消 → 无写入。
 */

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL/Redis；与 fin-integration.spec 一致——
// 缺省时 hasDb 恒 false，整套测试被 describe.skip 静默跳过，S7 验收证据落空）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/** 测试用户手机号与覆盖目标项目业务键 */
const TEST_PHONE = '+8613900000777';
const TEST_NAME = '取消回滚覆盖目标';
const TEST_YEAR = 2026;

/** 列字母 → 列号（A=1） */
function colNumber(colKey: string): number {
  let result = 0;
  for (const ch of colKey) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result;
}

/** 基于运行模板生成测试工作簿（数据行从第 3 行起，与生产导入一致） */
async function buildTestWorkbook(rows: Array<Record<string, string | number | null>>): Promise<Buffer> {
  const workbook = await loadTemplateWorkbook();
  const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
  let rowNumber = 3;
  for (const row of rows) {
    for (const [colKey, value] of Object.entries(row)) {
      sheet.getCell(rowNumber, colNumber(colKey)).value = value;
    }
    rowNumber += 1;
  }
  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/** 构造 multipart 请求体（file 字段 + choices 字段） */
function multipartBody(file: Buffer, choices: unknown): Buffer {
  const boundary = '----wbme-cancel-test';
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="import.xlsx"\r\n` +
        `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
    ),
    file,
    Buffer.from(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="choices"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `${JSON.stringify(choices)}\r\n--${boundary}--\r\n`,
    ),
  ]);
}

/** 发起原始 HTTP 请求（返回 req，便于调用方主动 destroy 模拟断连） */
function rawPost(server: http.Server, path: string, body: Buffer): http.ClientRequest {
  const address = server.address() as { port: number };
  return http.request({
    host: '127.0.0.1',
    port: address.port,
    path,
    method: 'POST',
    headers: {
      'content-type': 'multipart/form-data; boundary=----wbme-cancel-test',
      'content-length': body.length,
    },
  });
}

describeDb('Excel 导入取消/超时（S7 复核：事务回滚、无部分写入）', () => {
  let prisma: PrismaService;
  let service: ImportService;
  let redis: ReturnType<typeof createRedisClient>;
  let app: INestApplication;
  let server: http.Server;
  let operatorId = 0;
  let targetProjectId = 0;
  /** 测试前 FIN 系统 product_status 原值（afterAll 恢复） */
  let finSystemPrevStatus: string | null = null;

  beforeAll(async () => {
    // vitest 无 dist worker 产物：解析/构建在调用线程内联执行
    XlsxWorkerPool.inline = true;

    prisma = new PrismaService();
    redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const workerPool = new XlsxWorkerPool();
    service = new ImportService(prisma, workerPool, redis);

    // 操作人（超管：权限断言豁免）
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${TEST_PHONE}`;
    const userRows = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('导入取消测试员', 'MALE', ${TEST_PHONE}, 'ACTIVE', true, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    operatorId = userRows[0]!.id;

    // 系统开放校验（ExcelImportLockGuard → assertFinanceMaintainAccess）经
    // backstage.function_registry 视图（functions × systems）读取 product_status：
    // dev 库 FIN 系统可能为 COMING_SOON，守卫会在 Multer/handler 前抛 503，
    // 使 HTTP 层用例 3/4 测到的是权限拒绝而非取消传播（S7 复核修复）——先置 OPEN，afterAll 恢复
    const finSystemRows = await prisma.client.$queryRaw<Array<{ id: number; product_status: string }>>`
      SELECT id, product_status FROM backstage.systems WHERE code = 'FIN'
    `;
    finSystemPrevStatus = finSystemRows[0]?.product_status ?? null;
    await prisma.client.$executeRaw`UPDATE backstage.systems SET product_status = 'OPEN' WHERE code = 'FIN'`;

    // 覆盖目标项目（dataRevision=1，取消后必须保持不变）
    await prisma.client.$executeRaw`
      DELETE FROM fin.projects WHERE business_key = ${TEST_NAME}
    `;
    const projectRows = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO fin.projects (name, year, business_key, data_revision, created_at, updated_at)
      VALUES (${TEST_NAME}, ${TEST_YEAR}, ${TEST_NAME}, 1, NOW(), NOW())
      RETURNING id
    `;
    targetProjectId = projectRows[0]!.id;

    // 真实 Nest app（控制器 + 真实依赖 + 请求上下文；无会话守卫，测试注入 userId）
    const moduleRef = await Test.createTestingModule({
      controllers: [ExcelController],
      providers: [
        XlsxWorkerPool,
        ImportService,
        ExportService,
        ExcelImportLockGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(createRequestContextMiddleware('fin'));
    app.use((req: http.IncomingMessage, res: http.ServerResponse, next: (err?: unknown) => void) => {
      void setRequestUserId(operatorId);
      next();
    });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolvePromise) => server.listen(0, resolvePromise));
  });

  afterAll(async () => {
    // 先删审计与关联明细（project_operations 外键 RESTRICT），再删项目
    await prisma.client.$executeRaw`
      DELETE FROM fin.project_operations
      WHERE project_id IN (SELECT id FROM fin.projects WHERE business_key LIKE '取消回滚%')
    `;
    await prisma.client.$executeRaw`DELETE FROM fin.projects WHERE business_key LIKE '取消回滚%'`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${TEST_PHONE}`;
    if (finSystemPrevStatus !== null) {
      await prisma.client.$executeRaw`UPDATE backstage.systems SET product_status = ${finSystemPrevStatus} WHERE code = 'FIN'`;
    }
    await app?.close();
    await prisma.client.$disconnect();
    await redis.quit();
  });

  /** 生成覆盖文件：1 行覆盖目标 + 若干新增行（行数可参数化，用于制造处理窗口） */
  async function buildCancelFile(extraRows = 0): Promise<Buffer> {
    const rows: Array<Record<string, string | number | null>> = [
      { B: TEST_NAME, D: TEST_YEAR },
      { B: '取消回滚新增行', D: TEST_YEAR },
    ];
    for (let i = 1; i <= extraRows; i += 1) {
      rows.push({ B: `取消回滚批量行${i}`, D: TEST_YEAR });
    }
    return buildTestWorkbook(rows);
  }

  /** 预览并构造全量 choices：新增行需提交非 SKIP 选择才创建；覆盖行需带 projectId/dataRevision */
  async function buildChoices(buffer: Buffer): Promise<unknown[]> {
    const operator = { id: operatorId, name: '导入取消测试员', departments: [] };
    const preview = await service.preview(operator, buffer);
    return [
      ...preview.created.map((row) => ({ rowNumber: row.rowNumber, decision: 'OVERWRITE' as const })),
      ...preview.pendingChoice.map((row) => ({
        rowNumber: row.rowNumber,
        decision: 'OVERWRITE' as const,
        projectId: row.projectId,
        dataRevision: row.dataRevision,
      })),
    ];
  }

  /** 断言无任何部分写入：覆盖目标未变、无新增行、无审计残留 */
  async function assertNoPartialWrite(): Promise<void> {
    const target = await prisma.client.$queryRaw<Array<{ data_revision: number }>>`
      SELECT data_revision FROM fin.projects WHERE id = ${targetProjectId}
    `;
    expect(target[0]?.data_revision).toBe(1);
    const created = await prisma.client.$queryRaw<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM fin.projects
      WHERE business_key LIKE '取消回滚%' AND id <> ${targetProjectId}
    `;
    expect(Number(created[0]?.count ?? 0)).toBe(0);
    const ops = await prisma.client.$queryRaw<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM fin.project_operations
      WHERE project_id = ${targetProjectId} OR operator_id = ${operatorId}
    `;
    expect(Number(ops[0]?.count ?? 0)).toBe(0);
  }

  it('service 层：调用前已取消的 signal → 抛错且无任何写入', async () => {
    const buffer = await buildCancelFile();
    const choices = await buildChoices(buffer);
    const controller = new AbortController();
    controller.abort();
    const operator = { id: operatorId, name: '导入取消测试员', departments: [] };
    await expect(
      service.confirm(operator, buffer, choices as never, `cancel-pre:${Date.now()}`, controller.signal),
    ).rejects.toThrow();
    await assertNoPartialWrite();
  });

  it('service 层：写入窗口内取消 → 事务整批回滚、无部分写入', async () => {
    // 大文件（2000 行）保证确认处理耗时大于取消定时（M18 后写入已集合化分批，取消落在
    // 解析后检查点或分批/审计检查点均抛错回滚，不产生部分写入）
    const buffer = await buildCancelFile(2000);
    const operator = { id: operatorId, name: '导入取消测试员', departments: [] };
    const preview = await service.preview(operator, buffer);
    expect(preview.summary.created).toBeGreaterThan(1000);
    const choices = await buildChoices(buffer);
    const controller = new AbortController();
    const pending = service.confirm(operator, buffer, choices as never, `cancel-mid:${Date.now()}`, controller.signal);
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow();
    await assertNoPartialWrite();
    expect(await redis.get(`lock:fin-import:${operatorId}`)).toBeNull();
  });

  it('HTTP 层：上传中断（请求体发送一半断开）→ 无任何写入', async () => {
    const buffer = await buildCancelFile(10);
    const choices = await buildChoices(buffer);
    const body = multipartBody(buffer, choices);
    const req = rawPost(server, '/api/v1/profit/excel/import/confirm', body);
    const failure = new Promise<void>((resolvePromise) => {
      req.on('error', () => resolvePromise());
      req.on('response', () => resolvePromise());
    });
    req.write(body.subarray(0, Math.floor(body.length / 2)));
    setTimeout(() => req.destroy(), 50);
    await failure;
    // 稍等服务端处理窗口，再断言无写入；守卫须在 abort 路径释放 Redis 锁（勿仅靠 TTL）
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    await assertNoPartialWrite();
    expect(await redis.get(`lock:fin-import:${operatorId}`)).toBeNull();
  });

  it('HTTP 层：响应关闭（完整发送后客户端断开）→ 取消传播、无任何写入', async () => {
    // 大文件保证发送完成后服务端仍在处理（解析/写入窗口），此时 destroy 触发 res close → abort
    const buffer = await buildCancelFile(800);
    const choices = await buildChoices(buffer);
    const body = multipartBody(buffer, choices);
    const req = rawPost(server, '/api/v1/profit/excel/import/confirm', body);
    const failure = new Promise<void>((resolvePromise) => {
      req.on('error', () => resolvePromise());
      req.on('response', () => resolvePromise());
    });
    req.end(body);
    setTimeout(() => req.destroy(), 120);
    await failure;
    // 等待服务端取消传播与回滚完成
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    await assertNoPartialWrite();
    expect(await redis.get(`lock:fin-import:${operatorId}`)).toBeNull();
  });
});
