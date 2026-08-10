import 'reflect-metadata';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { of } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MaintenanceInterceptor } from './maintenance.interceptor';

function mockContext(method: string, path: string): never {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, path, originalUrl: path }),
    }),
  } as never;
}

describe('MaintenanceInterceptor（backstage PRD §10 维护状态拦截）', () => {
  let stateDir: string;
  let interceptor: MaintenanceInterceptor;

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'wbme-maint-test-'));
    process.env.RESTORE_STATE_DIR = stateDir;
    interceptor = new MaintenanceInterceptor();
  });

  afterAll(async () => {
    delete process.env.RESTORE_STATE_DIR;
    await rm(stateDir, { recursive: true, force: true });
  });

  it('无维护标记时写请求放行', async () => {
    await expect(
      interceptor.intercept(mockContext('POST', '/demo/write'), { handle: () => of({ ok: true }) } as never),
    ).resolves.toBeDefined();
  });

  it('维护标记存在时写请求抛出 503 SYSTEM_MAINTENANCE', async () => {
    await writeFile(join(stateDir, 'maintenance.marker'), new Date().toISOString(), 'utf8');
    await expect(
      interceptor.intercept(mockContext('POST', '/demo/write'), { handle: () => of({ ok: true }) } as never),
    ).rejects.toMatchObject({ entry: { code: 'SYSTEM_MAINTENANCE', httpStatus: 503 } });
  });

  it('维护期间读请求同样拒绝（应用层兜底，与 Nginx 口径一致）', async () => {
    await expect(
      interceptor.intercept(mockContext('GET', '/demo/read'), { handle: () => of({ ok: true }) } as never),
    ).rejects.toMatchObject({ entry: { code: 'SYSTEM_MAINTENANCE', httpStatus: 503 } });
  });

  it('维护期间健康探针放行', async () => {
    await expect(
      interceptor.intercept(mockContext('GET', '/readyz'), { handle: () => of({ ok: true }) } as never),
    ).resolves.toBeDefined();
    await expect(
      interceptor.intercept(mockContext('POST', '/readyz'), { handle: () => of({ ok: true }) } as never),
    ).resolves.toBeDefined();
  });

  it('维护标记读取异常时失败安全地拒绝业务请求', async () => {
    const markerPath = join(stateDir, 'maintenance.marker');
    await rm(markerPath, { force: true });
    await mkdir(markerPath);
    await expect(
      interceptor.intercept(mockContext('GET', '/demo/read'), { handle: () => of({ ok: true }) } as never),
    ).rejects.toMatchObject({ entry: { code: 'SYSTEM_MAINTENANCE', httpStatus: 503 } });
    await rm(markerPath, { recursive: true, force: true });
  });
});
