import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import type { HrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { DictService } from './dict.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/** 固定测试操作人 id（operation_logs 无外键，无需真实用户；测毕按该 id 清理日志） */
const OPERATOR_ID = 8_902_001;

/**
 * 人事字典删除（主 PRD §2.6 确认式删除）集成测试：
 * deletePreview 逐目标返回引用数（当前无业务引用表，恒为 0）、
 * deleteBatch 事务内物理删除、任一目标不存在整批回滚、幂等键重放返回原结果。
 */
describeDb('人事字典确认式删除（§2.6）', () => {
  let prisma: PrismaService;
  let dicts: DictService;
  const operator: HrOperationLogOperator = { id: OPERATOR_ID, name: 'dict测试操作人', departments: [] };
  const createdDictIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    dicts = new DictService(prisma);
    await prisma.client.$executeRaw`DELETE FROM hr.operation_logs WHERE operator_id = ${OPERATOR_ID}`;
  });

  afterAll(async () => {
    await prisma.client.$executeRaw`DELETE FROM hr.operation_logs WHERE operator_id = ${OPERATOR_ID}`;
    if (createdDictIds.length > 0) {
      await prisma.client.hrDict.deleteMany({ where: { id: { in: createdDictIds } } });
    }
    await prisma.client.$disconnect();
  });

  it('删除预览逐目标返回引用数（当前无业务引用表，恒为 0）；确认后物理删除', async () => {
    const suffix = `${Date.now()}`;
    const first = await dicts.create(operator, { dictType: 'PLACEHOLDER', name: `dict测试项A-${suffix}` });
    const second = await dicts.create(operator, { dictType: 'PLACEHOLDER', name: `dict测试项B-${suffix}` });
    createdDictIds.push(first.id, second.id);

    const preview = await dicts.deletePreview([first.id, second.id]);
    expect(preview.items).toEqual([
      { id: first.id, referencedCount: 0 },
      { id: second.id, referencedCount: 0 },
    ]);

    const deleted = await dicts.deleteBatch(operator, [first.id, second.id]);
    expect(deleted).toEqual({ deleted: 2 });
    const remaining = await prisma.client.hrDict.count({ where: { id: { in: [first.id, second.id] } } });
    expect(remaining).toBe(0);

    // 删除后目标不存在：预览抛 RESOURCE_NOT_FOUND（不静默吞掉错误目标）
    await expect(dicts.deletePreview([first.id])).rejects.toMatchObject({
      entry: { code: 'RESOURCE_NOT_FOUND' },
    });
  });

  it('任一目标不存在时整批回滚（其余目标不删除）', async () => {
    const suffix = `${Date.now()}`;
    const kept = await dicts.create(operator, { dictType: 'PLACEHOLDER', name: `dict测试项C-${suffix}` });
    createdDictIds.push(kept.id);

    await expect(dicts.deleteBatch(operator, [kept.id, 2_147_483_000])).rejects.toMatchObject({
      entry: { code: 'RESOURCE_NOT_FOUND' },
    });
    const remaining = await prisma.client.hrDict.findUnique({ where: { id: kept.id } });
    expect(remaining).not.toBeNull();
  });

  it('幂等键重放返回首次删除结果，不重复报错', async () => {
    const suffix = `${Date.now()}`;
    const target = await dicts.create(operator, { dictType: 'PLACEHOLDER', name: `dict测试项D-${suffix}` });
    createdDictIds.push(target.id);
    const idempotencyKey = `dict-test-${suffix}`;

    const first = await dicts.deleteBatch(operator, [target.id], idempotencyKey);
    const replayed = await dicts.deleteBatch(operator, [target.id], idempotencyKey);
    expect(first).toEqual({ deleted: 1 });
    expect(replayed).toEqual(first);
  });
});
