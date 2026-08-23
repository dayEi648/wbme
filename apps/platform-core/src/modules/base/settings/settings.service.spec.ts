import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

import { PrismaService } from '../../../prisma.service';
import { SETTING_KEYS, SettingsService } from './settings.service';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('SettingsService 平台设置（T4-5）', () => {
  let prisma: PrismaService;
  let service: SettingsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new SettingsService(prisma);
  });

  afterAll(async () => {
    await prisma.client.systemSetting.deleteMany({
      where: { key: { in: [SETTING_KEYS.QUERY_DEFAULT_WINDOW_DAYS] } },
    });
    await prisma.client.$disconnect();
  });

  it('listPlatformSettings 返回全部 PLATFORM 键与默认值', async () => {
    const result = await service.listPlatformSettings();
    expect(result.settings.length).toBe(23);
    const queryWindow = result.settings.find((s) => s.key === SETTING_KEYS.QUERY_DEFAULT_WINDOW_DAYS);
    expect(queryWindow?.defaultValue).toBe(30);
    expect(queryWindow?.value).toBe(30);
  });

  it('getNumber 读取新键默认值', async () => {
    const days = await service.getNumber(SETTING_KEYS.BACKUP_RETENTION_DAYS);
    expect(days).toBe(30);
  });
});
