-- 新增操作日志 QUERY 动作与日志清理所需索引。
-- PG ≥ 12 允许 ALTER TYPE ... ADD VALUE 位于事务内（同事务不使用新值即可）。
ALTER TYPE "base"."LogAction" ADD VALUE 'QUERY';

CREATE INDEX "operation_logs_action_type_created_at_idx" ON "base"."operation_logs"("action_type", "created_at");
CREATE INDEX "operation_logs_action_type_created_at_idx" ON "backstage"."operation_logs"("action_type", "created_at");
CREATE INDEX "error_logs_first_seen_at_idx" ON "backstage"."error_logs"("first_seen_at");
CREATE INDEX "security_logs_created_at_idx" ON "backstage"."security_logs"("created_at");
