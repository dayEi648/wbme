-- 视图依赖被 ALTER 的列类型（TIMESTAMP(3) -> TIMESTAMPTZ(3)）。
-- 先 DROP 视图（CASCADE 级联删除依赖它们的 hr.user_titles），
-- 由 Migration Runner 在全部部署单元迁移完成后统一重建（scripts/db-views/，幂等）。
DROP VIEW IF EXISTS "backstage"."operation_logs_union" CASCADE;
DROP VIEW IF EXISTS "backstage"."site_roles" CASCADE;

-- DropIndex（IF EXISTS：首次失败重试场景下该索引可能已被删除）
DROP INDEX IF EXISTS "user_table_prefs_user_id_page_key_idx";

-- AlterTable
ALTER TABLE "backstage"."announcements" ALTER COLUMN "published_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."approval_actions" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."approval_requests" ALTER COLUMN "submitted_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "cancelled_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "processed_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
-- task_uuid: TEXT -> UUID 使用 USING 无损转换（背景任务事实表为只追加表，不允许数据丢失）
ALTER TABLE "backstage"."background_tasks" ALTER COLUMN "task_uuid" SET DATA TYPE UUID USING "task_uuid"::uuid,
ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "finished_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "next_retry_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "timeout_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lease_expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
-- task_uuid: TEXT -> UUID 使用 USING 无损转换（备份记录可被 restores 外键引用，不允许数据丢失）
ALTER TABLE "backstage"."backups" ALTER COLUMN "task_uuid" SET DATA TYPE UUID USING "task_uuid"::uuid,
ALTER COLUMN "backup_time" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "finished_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."business_sections" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."employee_grants" ALTER COLUMN "granted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."error_logs" ALTER COLUMN "bucket_start" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "first_seen_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "last_seen_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "handled_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."functions" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."operation_logs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."permission_catalog_meta" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."permission_groups" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."release_logs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."restores" ALTER COLUMN "initiated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "finished_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."security_logs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."system_settings" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "backstage"."systems" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "activation_invitations" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "used_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "dingtalk_bindings" ALTER COLUMN "unbound_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "operation_logs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "user_table_prefs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "restored_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "background_tasks_task_uuid_key" ON "backstage"."background_tasks"("task_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "backups_task_uuid_key" ON "backstage"."backups"("task_uuid");

-- AddForeignKey
ALTER TABLE "backstage"."restores" ADD CONSTRAINT "restores_backup_id_fkey" FOREIGN KEY ("backup_id") REFERENCES "backstage"."backups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backstage"."restores" ADD CONSTRAINT "restores_emergency_backup_id_fkey" FOREIGN KEY ("emergency_backup_id") REFERENCES "backstage"."backups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
