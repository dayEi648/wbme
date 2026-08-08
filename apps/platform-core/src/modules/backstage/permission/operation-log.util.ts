import { createHash } from 'node:crypto';
import { BusinessException, frameworkErrors, PERMISSION_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { getRequestContext } from '@wbme/server';
import { Prisma, type PrismaClient } from '../../../generated/prisma/client';

/**
 * backstage 操作日志与幂等执行共享工具（主 PRD §3.3；T3-2 建立，T3-3 起供
 * 授权管理与权限组维护共用）。
 *
 * 幂等机制：重要写操作在业务事务内写入 backstage.operation_logs，并以
 * 「操作者 + 系统(BACKSTAGE) + 幂等作用域 + 幂等键」部分唯一约束为唯一事实；
 * 同键同指纹返回原结果引用，同键不同指纹返回 409；校验失败或事务回滚不留
 * 成功日志，修正后仍可重试。并发重复请求只有一个事务成功写入。
 */

/** 操作人上下文（操作日志快照 + 站点角色） */
export interface OperationLogOperator {
  id: number;
  name: string;
  isSuperAdmin: boolean;
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
 * 写入 backstage 操作日志（只追加）。
 * operator_departments 待 hr 组织视图接入后填充快照；requestId 取当前请求上下文。
 *
 * @param tx 事务客户端（与业务写入同事务，业务回滚日志同步回滚）
 * @param entry 日志内容；携带幂等字段时该行同时充当幂等记录
 */
export async function writeBackstageOperationLog(
  tx: Prisma.TransactionClient,
  entry: {
    operator: OperationLogOperator;
    actionType: 'CREATE' | 'UPDATE' | 'DELETE';
    summary: string;
    idempotencyScope?: string;
    idempotencyKey?: string;
    requestFingerprint?: string;
    resultReference?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.backstageOperationLog.create({
    data: {
      operatorId: entry.operator.id,
      operatorName: entry.operator.name,
      system: 'BACKSTAGE',
      feature: PERMISSION_MANAGE_FUNCTION_CODE,
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

/** 查询幂等记录（backstage 日志表；操作者非空时 COALESCE 与精确匹配等价） */
async function findIdempotencyRecord(
  prisma: PrismaClient,
  operatorId: number,
  scope: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  return prisma.backstageOperationLog.findFirst({
    where: { operatorId, system: 'BACKSTAGE', idempotencyScope: scope, idempotencyKey: key },
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
 * 幂等执行：业务写入与日志单事务；携带幂等键时以日志唯一约束去重。
 *
 * @param prisma platform-core Prisma 客户端
 * @param options.operator 操作人上下文（日志快照）
 * @param options.scope 幂等作用域（如 `permission.grants.save`）
 * @param options.idempotencyKey 客户端幂等键（缺省则不记录幂等、直接执行）
 * @param options.fingerprint 规范化请求指纹（fingerprintPayload 产物）
 * @param options.run 业务写入：返回业务结果与日志内容；幂等日志行由本函数写入
 *   （批量场景的逐人明细日志由 run 内部另行写入，仅本行携带幂等键与结果引用）。
 *   约定：所有依赖数据库状态的校验（存在性、状态、版本等）必须放在 run 内执行——
 *   幂等预检查先于 run，同键重放直接返回首次结果，不因首次成功后数据变化而误判
 *   （主 PRD §9.5：同键重试返回原结果；校验失败回滚不留记录，修正后仍可重试）。
 * @returns 业务结果；同键同指纹返回首次执行的结果引用
 * @throws IDEMPOTENCY_KEY_REUSED 同键不同指纹
 */
export async function executeIdempotentOperation<T>(
  prisma: PrismaClient,
  options: {
    operator: OperationLogOperator;
    scope: string;
    idempotencyKey?: string;
    fingerprint: string;
    run: (tx: Prisma.TransactionClient) => Promise<IdempotentOutcome<T>>;
  },
): Promise<T> {
  const { operator, scope, idempotencyKey, fingerprint, run } = options;
  if (!idempotencyKey) {
    return prisma.$transaction(async (tx) => {
      const outcome = await run(tx);
      await writeBackstageOperationLog(tx, { operator, actionType: outcome.actionType, summary: outcome.summary });
      return outcome.result;
    });
  }
  const existing = await findIdempotencyRecord(prisma, operator.id, scope, idempotencyKey);
  if (existing) {
    return replayIdempotencyRecord<T>(existing, fingerprint);
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const outcome = await run(tx);
      await writeBackstageOperationLog(tx, {
        operator,
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
    // 业务行写入由版本门/行锁串行化，P2002 必为幂等冲突
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const concurrent = await findIdempotencyRecord(prisma, operator.id, scope, idempotencyKey);
      if (concurrent) {
        return replayIdempotencyRecord<T>(concurrent, fingerprint);
      }
    }
    throw error;
  }
}
