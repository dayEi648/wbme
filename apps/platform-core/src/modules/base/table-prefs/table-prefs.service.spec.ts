import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

import { frameworkErrors } from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';
import { TablePrefsService } from './table-prefs.service';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('TablePrefsService 用户表格偏好（T4-12）', () => {
  let prisma: PrismaService;
  let service: TablePrefsService;
  const OWNER = 80_001; // 独立测试账号，避免与现有数据交叉
  const OTHER = 80_002;
  const PAGE = 'audit-test-page';

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new TablePrefsService(prisma);
  });

  afterAll(async () => {
    await prisma.client.userTablePref.deleteMany({ where: { userId: { in: [OWNER, OTHER] } } });
    await prisma.client.$disconnect();
  });

  it('同名筛选预设重复创建返回 VALIDATION_FAILED（唯一约束生效）', async () => {
    await service.createFilterPreset(OWNER, PAGE, { name: '常用', content: { a: 1 } });
    await expect(
      service.createFilterPreset(OWNER, PAGE, { name: '常用', content: { a: 2 } }),
    ).rejects.toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
  });

  it('不同账号的同名预设互不冲突', async () => {
    const { id } = (await service.createFilterPreset(OTHER, PAGE, { name: '常用', content: {} })) as { id: number };
    await expect(service.deleteFilterPreset(OTHER, id)).resolves.toEqual({ ok: true });
  });

  it('越权读取他人预设返回 RESOURCE_NOT_FOUND', async () => {
    const { id } = (await service.createFilterPreset(OWNER, PAGE, { name: '我的', content: {} })) as { id: number };
    await expect(service.deleteFilterPreset(OTHER, id)).rejects.toMatchObject({
      entry: { code: frameworkErrors.RESOURCE_NOT_FOUND.code },
    });
    await expect(service.updateFilterPreset(OTHER, id, { name: '我的', content: { x: 9 } })).rejects.toMatchObject({
      entry: { code: frameworkErrors.RESOURCE_NOT_FOUND.code },
    });
  });

  it('列设置按页 upsert：重复保存更新不新增行', async () => {
    await service.upsertColumnSetting(OWNER, PAGE, { content: { cols: ['a'] } });
    await service.upsertColumnSetting(OWNER, PAGE, { content: { cols: ['a', 'b'] } });
    const { item } = (await service.getColumnSetting(OWNER, PAGE)) as { item: { content: unknown } | null };
    expect(item?.content).toEqual({ cols: ['a', 'b'] });
    const rows = await prisma.client.userTablePref.count({
      where: { userId: OWNER, pageKey: PAGE, prefType: 'COLUMN_SETTING' },
    });
    expect(rows).toBe(1);
  });

  it('列表仅返回当前账号预设（无越权可见）', async () => {
    await service.createFilterPreset(OTHER, PAGE, { name: '别人的', content: { secret: 1 } });
    const { items } = (await service.listFilterPresets(OWNER, PAGE)) as { items: Array<{ userId: number }> };
    expect(items.every((row) => row.userId === OWNER)).toBe(true);
  });
});
