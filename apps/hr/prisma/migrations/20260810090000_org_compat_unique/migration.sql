-- M13：org_compat_records 幂等唯一约束 (restore_request_id, user_id)。
-- 恢复应用以 restoreRequestId 幂等；同恢复请求同用户仅允许一条兼容处理记录，
-- 并发同键异目标集靠此约束 + 事务内 P2002 捕获回读比对映射 RESTORE_TARGET_STALE（主 PRD §3.3/§9.5）。
CREATE UNIQUE INDEX "org_compat_records_restore_request_id_user_id_key"
  ON "org_compat_records" ("restore_request_id", "user_id");
