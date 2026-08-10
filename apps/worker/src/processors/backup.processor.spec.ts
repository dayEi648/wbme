import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * S2 复核补测：pg_dump 版本兼容校验（backup.processor.ts 此前被 backup-task 编排测试
 * 整体 mock，版本解析/比对逻辑零直接覆盖——生产 pg_dump 18 vs 服务器 18 的大版本
 * 漂移检测完全依赖本函数，漂移时备份链路硬失败）。
 *
 * execFile 以 vi.mock 替换并按命令分发 fake 输出（promisify 包装兼容参数形状）。
 */
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

// 模块级 PG_DUMP_PATH/PSQL_PATH 在 import 时读取 env；mock 后不真正执行，路径无关
import { assertPgClientCompatible } from './backup.processor';

function installFakePgTools(clientMajor: number, serverVersionNum: number): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cmd = String(args[0] ?? '');
    const callback = args.findLast((arg) => typeof arg === 'function') as
      | ((error: null, result: { stdout: string }) => void)
      | undefined;
    if (!callback) {
      return;
    }
    if (cmd.includes('pg_dump')) {
      callback(null, { stdout: `pg_dump (PostgreSQL) ${clientMajor}.4 (Ubuntu ${clientMajor}.4-1.pgdg12+1)` });
    } else {
      // psql SHOW server_version_num（MMmmpp：主版本 * 10000 + 小版本 * 100 + 补丁）
      callback(null, { stdout: String(serverVersionNum) });
    }
  });
}

describe('backup.processor pg_dump 版本校验（S2）', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('客户端主版本不低于服务器主版本时通过校验', async () => {
    installFakePgTools(18, 180004); // pg_dump 18.4 vs 服务器 18.4
    await expect(assertPgClientCompatible('postgresql://test')).resolves.toBeUndefined();
  });

  it('客户端主版本低于服务器主版本时抛错并附版本明细', async () => {
    installFakePgTools(15, 180004); // pg_dump 15.x vs 服务器 18.x——S2 原始故障形态
    await expect(assertPgClientCompatible('postgresql://test')).rejects.toThrow(
      /pg_dump 主版本\(15\.x\)低于 PostgreSQL 服务器主版本\(18\.x\)/,
    );
  });

  it('客户端主版本高于服务器主版本时通过校验（向下兼容）', async () => {
    installFakePgTools(19, 180004);
    await expect(assertPgClientCompatible('postgresql://test')).resolves.toBeUndefined();
  });
});
