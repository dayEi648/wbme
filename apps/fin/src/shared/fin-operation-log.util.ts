import { createHash } from 'node:crypto';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { getRequestContext } from '@wbme/server';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { loadSessionUser, loadUserName } from './cross-schema-auth';

/**
 * fin 操作日志与幂等执行共享工具（主 PRD §3.3）。
 *
 * 与 platform-core / asset / hr 的操作日志工具同构：重要写操作在业务事务内写入
 * fin.operation_logs，以「操作者 + 系统(FIN) + 幂等作用域 + 幂等键」部分唯一约束
 * （fin 迁移 init 已建 operation_logs_idempotency_unique）为唯一事实；
 * 同键同指纹返回原结果引用，同键不同指纹返回 409。
 *
 * operator_departments 快照形状契约（全站统一）：`[{ "id": number, "name": string }]`，
 * 经 hr.user_org 只读视图取当前全部归属部门（含停用部门：停用不改变既有组织关系）。
 */

/** 操作人上下文（操作日志快照 + 部门快照） */
export interface FinOperationLogOperator {
  id: number;
  name: string;
  /** 操作时归属部门快照 [{id, name}]（多部门并列；无部门为空数组） */
  departments: Array<{ id: number; name: string }>;
}

/** 幂等执行的业务产物：业务结果 + 操作日志内容 */
export interface IdempotentOutcome<T> {
  result: T;
  actionType: 'CREATE' | 'UPDATE' | 'DELETE';
  summary: string;
}

/** 幂等记录（用于重放判定） */
interface IdempotencyRecord {
  requestFingerprint: string | null;
  resultReference: Prisma.JsonValue;
}

/**
 * 加载操作人上下文（经 backstage.user_accounts 视图取姓名；部门快照经 hr.user_org 视图）。
 * 守卫已保证账号存在且 ACTIVE，此处兜底并发注销场景。
 *
 * @param prisma fin Prisma 客户端
 * @param operatorId 操作人 id
 * @returns 操作人上下文
 * @throws UNAUTHORIZED 操作人不存在或已删除
 */
export async function loadFinOperationLogOperator(
  prisma: PrismaClient,
  operatorId: number,
): Promise<FinOperationLogOperator> {
  const user = await loadSessionUser(prisma, operatorId);
  if (!user) {
    throw new BusinessException(frameworkErrors.UNAUTHORIZED);
  }
  const name = await loadUserName(prisma, operatorId);
  const departments = await loadOperatorDepartments(prisma, operatorId);
  return { id: operatorId, name, departments };
}

/**
 * 查询操作人当前全部归属部门快照 [{id, name}]（hr.user_org 视图，多部门并列）。
 *
 * @param prisma fin Prisma 客户端
 * @param userId 用户 id
 * @returns 部门快照数组
 */
export async function loadOperatorDepartments(
  prisma: PrismaClient,
  userId: number,
): Promise<Array<{ id: number; name: string }>> {
  const rows = await prisma.$queryRaw<Array<{ department_id: number; department_name: string }>>`
    SELECT DISTINCT department_id, department_name
    FROM hr.user_org
    WHERE user_id = ${userId}
    ORDER BY department_id
  `;
  return rows.map((row) => ({ id: row.department_id, name: row.department_name }));
}

/**
 * 规范化请求指纹负载：对象键排序、数组逐项规范化后按序列化结果排序。
 * 同一用户意图的请求即使字段/元素顺序不同也产生相同指纹，避免伪冲突（主 PRD §3.3）。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, canonicalize(item)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * 计算规范化请求指纹（SHA-256 十六进制）。
 *
 * @param payload 校验后的规范化 DTO 负载（不含密码/凭证等敏感字段）
 * @returns 64 位十六进制指纹
 */
export function fingerprintPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

/**
 * 写入 fin 操作日志（只追加；与业务写入同事务，业务回滚日志同步回滚）。
 * requestId 取当前请求上下文。
 *
 * @param tx 事务客户端
 * @param entry 日志内容（feature = fin 目录中的功能编码）；携带幂等字段时该行同时充当幂等记录
 */
export async function writeFinOperationLog(
  tx: Prisma.TransactionClient,
  entry: {
    operator: FinOperationLogOperator;
    /** 功能编码（目录稳定编码，如 finance_maintain / finance_config） */
    feature: string;
    actionType: 'CREATE' | 'UPDATE' | 'DELETE' | 'EXPORT';
    summary: string;
    idempotencyScope?: string;
    idempotencyKey?: string;
    requestFingerprint?: string;
    resultReference?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.operationLog.create({
    data: {
      operatorId: entry.operator.id,
      operatorName: entry.operator.name,
      operatorDepartments: entry.operator.departments as Prisma.InputJsonValue,
      system: 'FIN',
      feature: entry.feature,
      actionType: entry.actionType,
      summary: entry.summary,
      idempotencyScope: entry.idempotencyScope ?? null,
      idempotencyKey: entry.idempotencyKey ?? null,
      requestFingerprint: entry.requestFingerprint ?? null,
      resultReference: entry.resultReference,
      requestId: getRequestContext()?.requestId ?? null,
    },
  });
}

/** 查询幂等记录（fin 日志表；操作者非空时 COALESCE 与精确匹配等价） */
async function findIdempotencyRecord(
  prisma: PrismaClient,
  operatorId: number,
  scope: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  return prisma.operationLog.findFirst({
    where: { operatorId, system: 'FIN', idempotencyScope: scope, idempotencyKey: key },
    select: { requestFingerprint: true, resultReference: true },
  });
}

/** 重放幂等记录：指纹一致返回原结果引用，不一致抛 409（主 PRD §3.3） */
function replayIdempotencyRecord<T>(record: IdempotencyRecord, fingerprint: string): T {
  if (record.requestFingerprint !== fingerprint) {
    throw new BusinessException(frameworkErrors.IDEMPOTENCY_KEY_REUSED);
  }
  // 结果引用由写入方在同一事务写入，结构受控
  return record.resultReference as T;
}

/**
 * 幂等预检查：查询「操作者 + 系统 + 幂等作用域 + 幂等键」记录并按指纹重放。
 *
 * @returns found=true 时为重放结果（同键不同指纹抛 IDEMPOTENCY_KEY_REUSED）；found=false 可继续执行
 */
export async function tryReplayIdempotentResult<T>(
  prisma: PrismaClient,
  options: { operatorId: number; scope: string; idempotencyKey: string; fingerprint: string },
): Promise<{ found: true; result: T } | { found: false }> {
  const existing = await findIdempotencyRecord(prisma, options.operatorId, options.scope, options.idempotencyKey);
  if (!existing) {
    return { found: false };
  }
  return { found: true, result: replayIdempotencyRecord<T>(existing, options.fingerprint) };
}

/**
 * 幂等提交：业务写入与日志单事务（不做预检查；并发撞唯一约束时按指纹回放兜底）。
 * 未携带幂等键时只写普通日志。
 *
 * @param options.run 业务写入：返回业务结果与日志内容；幂等日志行由本函数写入。
 *   约定：所有依赖数据库状态的校验（存在性、状态、版本等）必须放在 run 内执行——
 *   重放先于 run 返回首次结果，不因首次成功后数据变化而误判（主 PRD §9.5）。
 * @returns 业务结果
 * @throws IDEMPOTENCY_KEY_REUSED 同键不同指纹
 */
export async function commitIdempotentOperation<T>(
  prisma: PrismaClient,
  options: {
    operator: FinOperationLogOperator;
    feature: string;
    scope: string;
    idempotencyKey?: string;
    fingerprint: string;
    run: (tx: Prisma.TransactionClient) => Promise<IdempotentOutcome<T>>;
  },
): Promise<T> {
  const { operator, feature, scope, idempotencyKey, fingerprint, run } = options;
  if (!idempotencyKey) {
    return prisma.$transaction(async (tx) => {
      const outcome = await run(tx);
      await writeFinOperationLog(tx, { operator, feature, actionType: outcome.actionType, summary: outcome.summary });
      return outcome.result;
    });
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const outcome = await run(tx);
      await writeFinOperationLog(tx, {
        operator,
        feature,
        actionType: outcome.actionType,
        summary: outcome.summary,
        idempotencyScope: scope,
        idempotencyKey,
        requestFingerprint: fingerprint,
        resultReference: outcome.result as unknown as Prisma.InputJsonValue,
      });
      return outcome.result;
    });
  } catch (error) {
    // 并发重复请求撞幂等唯一约束：取回先提交事务的结果（指纹不同则 409）；
    // 业务行写入由业务唯一约束/条件更新串行化，P2002 必为幂等冲突
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const concurrent = await findIdempotencyRecord(prisma, operator.id, scope, idempotencyKey);
      if (concurrent) {
        return replayIdempotencyRecord<T>(concurrent, fingerprint);
      }
    }
    throw error;
  }
}

/**
 * 幂等执行：业务写入与日志单事务；携带幂等键时以日志唯一约束去重。
 *
 * @param prisma fin Prisma 客户端
 * @param options.operator 操作人上下文（日志快照）
 * @param options.feature 功能编码（目录稳定编码）
 * @param options.scope 幂等作用域（如 `fin.project.create`）
 * @param options.idempotencyKey 客户端幂等键（缺省则不记录幂等、直接执行）
 * @param options.fingerprint 规范化请求指纹（fingerprintPayload 产物）
 * @param options.run 业务写入：返回业务结果与日志内容；幂等日志行由本函数写入
 * @returns 业务结果；同键同指纹返回首次执行的结果引用
 * @throws IDEMPOTENCY_KEY_REUSED 同键不同指纹
 */
export async function executeIdempotentOperation<T>(
  prisma: PrismaClient,
  options: {
    operator: FinOperationLogOperator;
    feature: string;
    scope: string;
    idempotencyKey?: string;
    fingerprint: string;
    run: (tx: Prisma.TransactionClient) => Promise<IdempotentOutcome<T>>;
  },
): Promise<T> {
  if (options.idempotencyKey) {
    const replayed = await tryReplayIdempotentResult<T>(prisma, {
      operatorId: options.operator.id,
      scope: options.scope,
      idempotencyKey: options.idempotencyKey,
      fingerprint: options.fingerprint,
    });
    if (replayed.found) {
      return replayed.result;
    }
  }
  return commitIdempotentOperation(prisma, options);
}
