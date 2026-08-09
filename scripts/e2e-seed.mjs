/**
 * E2E 测试夹具：创建/更新已激活的测试用户（超管）。
 *
 * 激活流程依赖钉钉 OAuth（外部服务），E2E 无法走真实激活；本脚本在测试库
 * 直接写入 ACTIVE 用户与 Argon2id 密码哈希（与密码登录服务同一算法与参数）。
 * 幂等：手机号已存在时更新密码与超管标记。
 *
 * 用法：node scripts/e2e-seed.mjs（仓库根；依赖经 platform-core 上下文解析）
 * 环境变量：DATABASE_URL 必填（未设置时读取仓库根 .env）；
 * E2E_USER_NAME / E2E_USER_PHONE / E2E_USER_PASSWORD 可覆盖默认值。
 */
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

// 依赖经 workspace 包上下文解析（pnpm 严格隔离：@node-rs/argon2 在 platform-core、pg 在 migration-runner）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformCoreRequire = createRequire(resolve(repoRoot, 'apps/platform-core/package.json'));
const migrationRunnerRequire = createRequire(resolve(repoRoot, 'apps/migration-runner/package.json'));
const { hash } = platformCoreRequire('@node-rs/argon2');
const { Client } = migrationRunnerRequire('pg');

try {
  loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  // .env 不存在时使用进程环境变量（CI / 部署注入场景）
}

const NAME = process.env.E2E_USER_NAME ?? 'E2E测试员';
const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[e2e-seed] DATABASE_URL 未配置');
    process.exit(1);
  }
  const passwordHash = await hash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const existing = await client.query('SELECT id FROM base.users WHERE phone = $1 AND deleted_at IS NULL', [PHONE]);
    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE base.users
         SET password_hash = $1, status = 'ACTIVE', is_super_admin = true,
             session_version = session_version + 1, permission_version = permission_version + 1,
             updated_by = id, updated_at = now()
         WHERE id = $2`,
        [passwordHash, existing.rows[0].id],
      );
      console.log(`[e2e-seed] 已更新 E2E 用户 id=${existing.rows[0].id}（${PHONE}）`);
    } else {
      const inserted = await client.query(
        `INSERT INTO base.users
           (name, gender, phone, password_hash, status, is_super_admin, session_version, permission_version, lifecycle_version, created_by, created_at, updated_at)
         VALUES ($1, 'MALE', $2, $3, 'ACTIVE', true, 0, 0, 0, NULL, now(), now())
         RETURNING id`,
        [NAME, PHONE, passwordHash],
      );
      console.log(`[e2e-seed] 已创建 E2E 用户 id=${inserted.rows[0].id}（${PHONE}）`);
    }
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error('[e2e-seed] 失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
