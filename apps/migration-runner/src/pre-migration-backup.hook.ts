import { spawn } from 'node:child_process';

/**
 * 迁移前「立即备份」钩子（主 PRD §9.9、实现规划 T0-6；T4-7 数据备份接入前的占位实现）。
 *
 * 纪律：存在待执行迁移时，迁移执行前必须经过本钩子——
 * - 未配置 `PRE_MIGRATION_BACKUP_CMD`：打印「跳过（T4-7 接入）」并继续（开发环境默认路径）；
 * - 已配置：执行该命令（部署环境注入的备份脚本），失败即抛出、停止本次迁移（发布纪律：失败即停）。
 *
 * T4-7 接入方式：数据备份能力就绪后，将本钩子实现替换为「创建并等待一条立即备份任务成功」
 * 的平台备份调用（backstage PRD §10），保持调用点（Migration Runner 迁移执行前）与
 * 「失败即停」语义不变；环境变量命令通道届时废弃。
 */

/** 命令执行结果 */
export interface HookExecResult {
  ok: boolean;
  code: number | null;
}

/** 命令执行器（注入替身便于测试） */
export type HookExec = (command: string) => Promise<HookExecResult>;

/** 默认执行器：经 shell 执行部署环境注入的命令 */
function defaultExec(command: string): Promise<HookExecResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { stdio: 'inherit', shell: true, env: process.env });
    child.on('close', (code) => resolvePromise({ ok: code === 0, code }));
    child.on('error', () => resolvePromise({ ok: false, code: null }));
  });
}

/**
 * 执行迁移前备份钩子。
 *
 * @param exec 命令执行器（默认经 shell 执行；测试注入替身）
 * @param env 环境变量（默认 process.env）
 * @throws 已配置命令且执行失败时抛出（调用方停止迁移）
 */
export async function runPreMigrationBackup(
  exec: HookExec = defaultExec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = env.PRE_MIGRATION_BACKUP_CMD?.trim();
  if (!command) {
    console.log('[pre-migration-backup] 未配置 PRE_MIGRATION_BACKUP_CMD，跳过（T4-7 接入平台备份能力）');
    return;
  }
  console.log('[pre-migration-backup] 执行迁移前备份命令 ...');
  const result = await exec(command);
  if (!result.ok) {
    throw new Error(`[pre-migration-backup] 迁移前备份失败（退出码 ${result.code ?? '未知'}），按发布纪律停止迁移`);
  }
  console.log('[pre-migration-backup] 迁移前备份完成');
}
