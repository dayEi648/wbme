-- 操作日志联合只读视图（主 PRD §3.3、§9.9）
-- 拥有模块：backstage；base/backstage/asset/hr/fin 各自 schema 维护同构 operation_logs 表，
-- 管理后台经本视图统一查询全部模块日志，不要求各业务服务容器在线。
-- 新增模块时必须同步扩展本视图。
-- action_type 为各 schema 各自的 PostgreSQL 枚举类型（schema 级类型），联合查询时统一转换为 text。
-- 幂等：CREATE OR REPLACE VIEW，由 Migration Runner 统一执行。

CREATE OR REPLACE VIEW "backstage"."operation_logs_union" AS
SELECT id, operator_id, operator_name, operator_departments,
       system, feature, action_type::text AS action_type, summary,
       idempotency_scope, idempotency_key, request_fingerprint,
       result_reference, request_id, created_at
FROM "base"."operation_logs"
UNION ALL
SELECT id, operator_id, operator_name, operator_departments,
       system, feature, action_type::text AS action_type, summary,
       idempotency_scope, idempotency_key, request_fingerprint,
       result_reference, request_id, created_at
FROM "backstage"."operation_logs"
UNION ALL
SELECT id, operator_id, operator_name, operator_departments,
       system, feature, action_type::text AS action_type, summary,
       idempotency_scope, idempotency_key, request_fingerprint,
       result_reference, request_id, created_at
FROM "asset"."operation_logs"
UNION ALL
SELECT id, operator_id, operator_name, operator_departments,
       system, feature, action_type::text AS action_type, summary,
       idempotency_scope, idempotency_key, request_fingerprint,
       result_reference, request_id, created_at
FROM "hr"."operation_logs"
UNION ALL
SELECT id, operator_id, operator_name, operator_departments,
       system, feature, action_type::text AS action_type, summary,
       idempotency_scope, idempotency_key, request_fingerprint,
       result_reference, request_id, created_at
FROM "fin"."operation_logs";
