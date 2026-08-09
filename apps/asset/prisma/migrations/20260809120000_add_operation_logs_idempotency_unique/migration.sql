-- A-29 幂等唯一约束（与 hr/base/backstage 操作日志同构，T7）：操作者 + 作用域 + 幂等键，系统操作以 0 兜底
CREATE UNIQUE INDEX "operation_logs_idempotency_unique" ON "asset"."operation_logs" (COALESCE(operator_id, 0), system, idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL;
