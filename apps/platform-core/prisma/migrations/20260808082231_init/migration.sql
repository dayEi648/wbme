-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "backstage";

-- CreateEnum
CREATE TYPE "backstage"."ProductStatus" AS ENUM ('OPEN', 'COMING_SOON');

-- CreateEnum
CREATE TYPE "backstage"."DataScope" AS ENUM ('SELF', 'DEPARTMENT', 'COMPANY');

-- CreateEnum
CREATE TYPE "backstage"."SettingValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "backstage"."SettingGroup" AS ENUM ('PLATFORM', 'AI');

-- CreateEnum
CREATE TYPE "backstage"."LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "backstage"."ErrorStatus" AS ENUM ('PENDING', 'HANDLED', 'IGNORED');

-- CreateEnum
CREATE TYPE "backstage"."SecurityEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGOUT', 'ACCOUNT_LOCK', 'ACCOUNT_UNLOCK', 'IP_LOCK', 'IP_UNLOCK', 'ACCOUNT_ACTIVATED', 'INVITATION_ISSUED', 'INVITATION_USED', 'PASSWORD_CHANGED', 'PASSWORD_RESET_ISSUED', 'PASSWORD_RESET_COMPLETED', 'BINDING_CHANGED_ISSUED', 'BINDING_CHANGED_COMPLETED', 'BINDING_CHANGED_FAILED', 'PHONE_SYNCED', 'PHONE_SYNC_CONFLICT', 'INTERNAL_TOKEN_FAILED');

-- CreateEnum
CREATE TYPE "backstage"."SecurityResult" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateEnum
CREATE TYPE "backstage"."TaskStatus" AS ENUM ('PENDING_ENQUEUE', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "backstage"."TaskInitiatorType" AS ENUM ('USER', 'SCHEDULER');

-- CreateEnum
CREATE TYPE "backstage"."AnnouncementStatus" AS ENUM ('DRAFT', 'PUBLISHING', 'REVOKED');

-- CreateEnum
CREATE TYPE "backstage"."BackupType" AS ENUM ('SCHEDULED', 'IMMEDIATE', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "backstage"."BackupStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "backstage"."RestoreStatus" AS ENUM ('PENDING', 'PRECHECK', 'MAINTENANCE', 'RESTORING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "backstage"."ApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "backstage"."ApprovalAction" AS ENUM ('SUBMIT', 'CANCEL', 'APPROVE', 'REJECT', 'AUTO_CANCEL');

-- CreateEnum
CREATE TYPE "backstage"."CancelSource" AS ENUM ('USER', 'ACCOUNT_DEACTIVATED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "backstage"."ApprovalRequestType" AS ENUM ('PROFILE_CHANGE');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('VALID', 'USED', 'REVOKED');

-- CreateEnum
CREATE TYPE "BindingStatus" AS ENUM ('BOUND', 'UNBOUND');

-- CreateEnum
CREATE TYPE "LogAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'EXPORT');

-- CreateEnum
CREATE TYPE "TablePrefType" AS ENUM ('FILTER_PRESET', 'COLUMN_SETTING');

-- CreateTable
CREATE TABLE "backstage"."systems" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "product_status" "backstage"."ProductStatus" NOT NULL DEFAULT 'COMING_SOON',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "systems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."business_sections" (
    "id" SERIAL NOT NULL,
    "system_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."functions" (
    "id" SERIAL NOT NULL,
    "system_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data_scope_options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sort" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "functions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."permission_catalog_meta" (
    "id" SERIAL NOT NULL,
    "catalog_version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permission_catalog_meta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."employee_grants" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "function_code" TEXT NOT NULL,
    "data_scope" "backstage"."DataScope" NOT NULL,
    "granted_by" INTEGER NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."permission_groups" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_by" INTEGER,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "permission_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."permission_group_items" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "system_code" TEXT NOT NULL,
    "function_code" TEXT NOT NULL,
    "data_scope" "backstage"."DataScope" NOT NULL,

    CONSTRAINT "permission_group_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."system_settings" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "backstage"."SettingValueType" NOT NULL,
    "group" "backstage"."SettingGroup" NOT NULL,
    "label" TEXT NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."error_logs" (
    "id" SERIAL NOT NULL,
    "level" "backstage"."LogLevel" NOT NULL,
    "service" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "error_category" TEXT NOT NULL,
    "deploy_commit" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "first_request_id" TEXT,
    "last_request_id" TEXT,
    "sample" TEXT,
    "status" "backstage"."ErrorStatus" NOT NULL DEFAULT 'PENDING',
    "handled_by" INTEGER,
    "handled_at" TIMESTAMP(3),
    "remark" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."security_logs" (
    "id" SERIAL NOT NULL,
    "event_type" "backstage"."SecurityEventType" NOT NULL,
    "actor_id" INTEGER,
    "target_user_id" INTEGER,
    "result" "backstage"."SecurityResult" NOT NULL,
    "reason" TEXT,
    "source_ip" TEXT,
    "context" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."background_tasks" (
    "id" SERIAL NOT NULL,
    "task_uuid" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "initiator_id" INTEGER,
    "initiator_type" "backstage"."TaskInitiatorType" NOT NULL,
    "ref" JSONB,
    "status" "backstage"."TaskStatus" NOT NULL DEFAULT 'PENDING_ENQUEUE',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "timeout_at" TIMESTAMP(3),
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "background_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."release_logs" (
    "id" SERIAL NOT NULL,
    "release_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "commit_subjects" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."announcements" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "status" "backstage"."AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "publisher_id" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_by" INTEGER,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."backups" (
    "id" SERIAL NOT NULL,
    "task_uuid" TEXT,
    "task_type" "backstage"."BackupType" NOT NULL,
    "status" "backstage"."BackupStatus" NOT NULL DEFAULT 'RUNNING',
    "backup_time" TIMESTAMP(3) NOT NULL,
    "pg_version" TEXT,
    "file_size" BIGINT,
    "checksum" TEXT,
    "oss_object_key" TEXT,
    "oss_manifest_key" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."restores" (
    "id" SERIAL NOT NULL,
    "restore_uuid" TEXT NOT NULL,
    "backup_id" INTEGER,
    "emergency_backup_id" INTEGER,
    "status" "backstage"."RestoreStatus" NOT NULL DEFAULT 'PENDING',
    "stage" TEXT,
    "initiated_by" INTEGER NOT NULL,
    "initiated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."approval_requests" (
    "id" SERIAL NOT NULL,
    "application_no" TEXT NOT NULL,
    "request_type" "backstage"."ApprovalRequestType" NOT NULL,
    "applicant_id" INTEGER NOT NULL,
    "applicant_name" TEXT NOT NULL,
    "applicant_department_snapshot" JSONB,
    "proxy_id" INTEGER,
    "proxy_name" TEXT,
    "ref_request_id" INTEGER,
    "status" "backstage"."ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMP(3),
    "cancelled_by" INTEGER,
    "cancelled_at" TIMESTAMP(3),
    "cancel_source" "backstage"."CancelSource",
    "processor_id" INTEGER,
    "processor_name" TEXT,
    "processed_at" TIMESTAMP(3),
    "opinion" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."approval_actions" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "action" "backstage"."ApprovalAction" NOT NULL,
    "actor_id" INTEGER NOT NULL,
    "actor_name" TEXT NOT NULL,
    "opinion" TEXT,
    "cancel_source" "backstage"."CancelSource",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."profile_change_requests" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "user_name" TEXT NOT NULL,
    "department_snapshot" JSONB,
    "old_name" TEXT NOT NULL,
    "new_name" TEXT NOT NULL,
    "old_gender" "Gender" NOT NULL,
    "new_gender" "Gender" NOT NULL,

    CONSTRAINT "profile_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backstage"."operation_logs" (
    "id" SERIAL NOT NULL,
    "operator_id" INTEGER,
    "operator_name" TEXT,
    "operator_departments" JSONB,
    "system" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "action_type" "LogAction" NOT NULL,
    "summary" TEXT NOT NULL,
    "idempotency_scope" TEXT,
    "idempotency_key" TEXT,
    "request_fingerprint" TEXT,
    "result_reference" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "phone" TEXT NOT NULL,
    "password_hash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "session_version" INTEGER NOT NULL DEFAULT 0,
    "permission_version" INTEGER NOT NULL DEFAULT 0,
    "lifecycle_version" INTEGER NOT NULL DEFAULT 0,
    "restored_by" INTEGER,
    "restored_at" TIMESTAMP(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_by" INTEGER,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activation_invitations" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'VALID',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activation_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dingtalk_bindings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "dingtalk_union_id" TEXT NOT NULL,
    "status" "BindingStatus" NOT NULL DEFAULT 'BOUND',
    "unbound_at" TIMESTAMP(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dingtalk_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_logs" (
    "id" SERIAL NOT NULL,
    "operator_id" INTEGER,
    "operator_name" TEXT,
    "operator_departments" JSONB,
    "system" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "action_type" "LogAction" NOT NULL,
    "summary" TEXT NOT NULL,
    "idempotency_scope" TEXT,
    "idempotency_key" TEXT,
    "request_fingerprint" TEXT,
    "result_reference" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_table_prefs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "page_key" TEXT NOT NULL,
    "pref_type" "TablePrefType" NOT NULL,
    "name" TEXT,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_table_prefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "systems_code_key" ON "backstage"."systems"("code");

-- CreateIndex
CREATE UNIQUE INDEX "business_sections_system_id_code_key" ON "backstage"."business_sections"("system_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "functions_code_key" ON "backstage"."functions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_grants_user_id_function_code_data_scope_key" ON "backstage"."employee_grants"("user_id", "function_code", "data_scope");

-- CreateIndex
CREATE UNIQUE INDEX "permission_groups_name_key" ON "backstage"."permission_groups"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permission_group_items_group_id_function_code_data_scope_key" ON "backstage"."permission_group_items"("group_id", "function_code", "data_scope");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "backstage"."system_settings"("key");

-- CreateIndex
CREATE INDEX "error_logs_status_last_seen_at_idx" ON "backstage"."error_logs"("status", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "background_tasks_task_uuid_key" ON "backstage"."background_tasks"("task_uuid");

-- CreateIndex
CREATE INDEX "background_tasks_status_next_retry_at_idx" ON "backstage"."background_tasks"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "background_tasks_status_lease_expires_at_idx" ON "backstage"."background_tasks"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "release_logs_release_id_key" ON "backstage"."release_logs"("release_id");

-- CreateIndex
CREATE INDEX "announcements_status_idx" ON "backstage"."announcements"("status");

-- CreateIndex
CREATE UNIQUE INDEX "backups_task_uuid_key" ON "backstage"."backups"("task_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "restores_restore_uuid_key" ON "backstage"."restores"("restore_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_application_no_key" ON "backstage"."approval_requests"("application_no");

-- CreateIndex
CREATE INDEX "approval_requests_status_submitted_at_idx" ON "backstage"."approval_requests"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "approval_requests_applicant_id_idx" ON "backstage"."approval_requests"("applicant_id");

-- CreateIndex
CREATE INDEX "approval_requests_processor_id_idx" ON "backstage"."approval_requests"("processor_id");

-- CreateIndex
CREATE INDEX "approval_requests_request_type_status_idx" ON "backstage"."approval_requests"("request_type", "status");

-- CreateIndex
CREATE INDEX "approval_actions_request_id_created_at_idx" ON "backstage"."approval_actions"("request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "profile_change_requests_request_id_key" ON "backstage"."profile_change_requests"("request_id");

-- CreateIndex
CREATE INDEX "operation_logs_system_created_at_idx" ON "backstage"."operation_logs"("system", "created_at");

-- CreateIndex
CREATE INDEX "operation_logs_operator_id_created_at_idx" ON "backstage"."operation_logs"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "users_phone_idx" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_status_deleted_at_idx" ON "users"("status", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "dingtalk_bindings_dingtalk_union_id_key" ON "dingtalk_bindings"("dingtalk_union_id");

-- CreateIndex
CREATE INDEX "operation_logs_system_created_at_idx" ON "operation_logs"("system", "created_at");

-- CreateIndex
CREATE INDEX "operation_logs_operator_id_created_at_idx" ON "operation_logs"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "user_table_prefs_user_id_page_key_idx" ON "user_table_prefs"("user_id", "page_key");

-- AddForeignKey
ALTER TABLE "backstage"."business_sections" ADD CONSTRAINT "business_sections_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "backstage"."systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backstage"."functions" ADD CONSTRAINT "functions_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "backstage"."systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backstage"."functions" ADD CONSTRAINT "functions_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "backstage"."business_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backstage"."permission_group_items" ADD CONSTRAINT "permission_group_items_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "backstage"."permission_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backstage"."approval_actions" ADD CONSTRAINT "approval_actions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "backstage"."approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backstage"."profile_change_requests" ADD CONSTRAINT "profile_change_requests_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "backstage"."approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_invitations" ADD CONSTRAINT "activation_invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dingtalk_bindings" ADD CONSTRAINT "dingtalk_bindings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 补充：部分唯一索引与 CHECK 约束
-- （Prisma schema 不表达这些 PostgreSQL 能力，按 docs/database-design 逐条落地）
-- ============================================================

-- B-1 users：手机号唯一仅限"待激活 + 正常"（注销手机号转为历史快照）
CREATE UNIQUE INDEX "users_phone_active_unique" ON "users" ("phone") WHERE status IN ('PENDING_ACTIVATION', 'ACTIVE') AND deleted_at IS NULL;

-- B-1 users：正常账号必有密码
ALTER TABLE "users" ADD CONSTRAINT "users_active_password_check" CHECK (status <> 'ACTIVE' OR password_hash IS NOT NULL);

-- B-2 activation_invitations：同一账号最多一个有效邀请
CREATE UNIQUE INDEX "activation_invitations_user_valid_unique" ON "activation_invitations" ("user_id") WHERE status = 'VALID';

-- B-3 dingtalk_bindings：一个账号同时最多一条有效绑定
CREATE UNIQUE INDEX "dingtalk_bindings_user_bound_unique" ON "dingtalk_bindings" ("user_id") WHERE status = 'BOUND';

-- B-4 幂等唯一约束（base 与 backstage 操作日志同构）：操作者 + 作用域 + 幂等键，系统操作以 0 兜底
CREATE UNIQUE INDEX "operation_logs_idempotency_unique" ON "operation_logs" (COALESCE(operator_id, 0), system, idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX "operation_logs_idempotency_unique" ON "backstage"."operation_logs" (COALESCE(operator_id, 0), system, idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- B-5 user_table_prefs：同一页面同名预设唯一；每页一条列设置
CREATE UNIQUE INDEX "user_table_prefs_preset_unique" ON "user_table_prefs" ("user_id", "page_key", "name") WHERE pref_type = 'FILTER_PRESET';
CREATE UNIQUE INDEX "user_table_prefs_column_unique" ON "user_table_prefs" ("user_id", "page_key") WHERE pref_type = 'COLUMN_SETTING';

-- S-4 permission_catalog_meta：恒为单行
ALTER TABLE "backstage"."permission_catalog_meta" ADD CONSTRAINT "permission_catalog_meta_single_row_check" CHECK (id = 1);

-- S-9 error_logs：并发聚合原子 UPSERT（指纹 + 五分钟时间桶，待处理状态唯一）
CREATE UNIQUE INDEX "error_logs_pending_fingerprint_unique" ON "backstage"."error_logs" ("fingerprint", "bucket_start") WHERE status = 'PENDING';

-- S-11 background_tasks：失败终态"结束时间倒序"条件索引（最近 24 小时失败汇总）
CREATE INDEX "background_tasks_failed_finished_idx" ON "backstage"."background_tasks" ("finished_at" DESC) WHERE status = 'FAILED';

-- S-13 announcements：全平台同时最多一条"正在展示"
CREATE UNIQUE INDEX "announcements_publishing_unique" ON "backstage"."announcements" ("status") WHERE status = 'PUBLISHING' AND deleted_at IS NULL;

-- S-16/S-18：同一员工同时最多一条待审批资料修改申请
CREATE UNIQUE INDEX "approval_requests_profile_pending_unique" ON "backstage"."approval_requests" ("applicant_id") WHERE request_type = 'PROFILE_CHANGE' AND status = 'PENDING';
