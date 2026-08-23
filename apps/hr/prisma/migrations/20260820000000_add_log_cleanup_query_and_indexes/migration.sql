-- 新增操作日志 QUERY 动作与日志清理所需索引。
ALTER TYPE "LogAction" ADD VALUE 'QUERY';

CREATE INDEX "operation_logs_action_type_created_at_idx" ON "operation_logs"("action_type", "created_at");
