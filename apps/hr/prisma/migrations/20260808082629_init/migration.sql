-- CreateEnum
CREATE TYPE "DeptStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SiteRole" AS ENUM ('SUPER_ADMIN', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "HrDictType" AS ENUM ('PLACEHOLDER');

-- CreateEnum
CREATE TYPE "DictStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "HolidayDateType" AS ENUM ('WORKDAY', 'WEEKEND', 'HOLIDAY', 'ADJUSTED_HOLIDAY', 'ADJUSTED_WORKDAY');

-- CreateEnum
CREATE TYPE "HrRequestType" AS ENUM ('OVERTIME', 'POSITION_CHANGE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('SUBMIT', 'CANCEL', 'APPROVE', 'REJECT', 'AUTO_CANCEL');

-- CreateEnum
CREATE TYPE "CancelSource" AS ENUM ('USER', 'ACCOUNT_DEACTIVATED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "SettingValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "LogAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'EXPORT');

-- CreateEnum
CREATE TYPE "TablePrefType" AS ENUM ('FILTER_PRESET', 'COLUMN_SETTING');

-- CreateTable
CREATE TABLE "org_meta" (
    "id" SERIAL NOT NULL,
    "user_org_version" INTEGER NOT NULL DEFAULT 0,
    "org_tree_version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_meta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" "DeptStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_leaders" (
    "id" SERIAL NOT NULL,
    "department_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "user_name" TEXT NOT NULL,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_leaders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PositionStatus" NOT NULL DEFAULT 'ACTIVE',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "allow_self_apply" BOOLEAN NOT NULL DEFAULT false,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_departments" (
    "id" SERIAL NOT NULL,
    "position_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "title_rules" (
    "id" SERIAL NOT NULL,
    "title_name" TEXT NOT NULL,
    "department_id" INTEGER,
    "position_id" INTEGER,
    "role_condition" "SiteRole",
    "status" "RuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_by" INTEGER,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "title_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_departments" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_positions" (
    "user_id" INTEGER NOT NULL,
    "position_id" INTEGER,
    "assigned_by" INTEGER NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_positions_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "org_compat_records" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "restore_request_id" TEXT NOT NULL,
    "cleared_departments" JSONB,
    "position_cleared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_compat_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" SERIAL NOT NULL,
    "application_no" TEXT NOT NULL,
    "request_type" "HrRequestType" NOT NULL,
    "applicant_id" INTEGER NOT NULL,
    "applicant_name" TEXT NOT NULL,
    "applicant_department_snapshot" JSONB,
    "proxy_id" INTEGER,
    "proxy_name" TEXT,
    "ref_request_id" INTEGER,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMP(3),
    "cancelled_by" INTEGER,
    "cancelled_at" TIMESTAMP(3),
    "cancel_source" "CancelSource",
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
CREATE TABLE "approval_actions" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "action" "ApprovalAction" NOT NULL,
    "actor_id" INTEGER NOT NULL,
    "actor_name" TEXT NOT NULL,
    "opinion" TEXT,
    "cancel_source" "CancelSource",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_items" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "user_name" TEXT NOT NULL,
    "department_snapshot" JSONB NOT NULL,
    "overtime_date" DATE NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "holiday_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_change_requests" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "user_name" TEXT NOT NULL,
    "department_snapshot" JSONB NOT NULL,
    "target_department_id" INTEGER NOT NULL,
    "target_department_name" TEXT NOT NULL,
    "target_position_id" INTEGER NOT NULL,
    "target_position_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_results" (
    "holiday_date" DATE NOT NULL,
    "date_type" "HolidayDateType" NOT NULL,
    "weekday" INTEGER NOT NULL,
    "provider_id" TEXT NOT NULL,
    "raw_digest" TEXT NOT NULL,
    "normalized" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holiday_results_pkey" PRIMARY KEY ("holiday_date")
);

-- CreateTable
CREATE TABLE "hr_settings" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "SettingValueType" NOT NULL,
    "label" TEXT NOT NULL,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_dicts" (
    "id" SERIAL NOT NULL,
    "dict_type" "HrDictType" NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" "DictStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_dicts_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "departments_parent_id_idx" ON "departments"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "department_leaders_department_id_user_id_key" ON "department_leaders"("department_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "positions_name_key" ON "positions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "position_departments_position_id_department_id_key" ON "position_departments"("position_id", "department_id");

-- CreateIndex
CREATE INDEX "user_departments_department_id_idx" ON "user_departments"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_departments_user_id_department_id_key" ON "user_departments"("user_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_application_no_key" ON "approval_requests"("application_no");

-- CreateIndex
CREATE INDEX "approval_requests_status_submitted_at_idx" ON "approval_requests"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "approval_requests_applicant_id_idx" ON "approval_requests"("applicant_id");

-- CreateIndex
CREATE INDEX "approval_requests_processor_id_idx" ON "approval_requests"("processor_id");

-- CreateIndex
CREATE INDEX "approval_requests_request_type_status_idx" ON "approval_requests"("request_type", "status");

-- CreateIndex
CREATE INDEX "approval_actions_request_id_created_at_idx" ON "approval_actions"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "overtime_items_user_id_overtime_date_idx" ON "overtime_items"("user_id", "overtime_date");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_items_request_id_user_id_key" ON "overtime_items"("request_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "position_change_requests_request_id_key" ON "position_change_requests"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_settings_key_key" ON "hr_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "hr_dicts_dict_type_name_key" ON "hr_dicts"("dict_type", "name");

-- CreateIndex
CREATE INDEX "operation_logs_system_created_at_idx" ON "operation_logs"("system", "created_at");

-- CreateIndex
CREATE INDEX "operation_logs_operator_id_created_at_idx" ON "operation_logs"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "user_table_prefs_user_id_page_key_idx" ON "user_table_prefs"("user_id", "page_key");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_leaders" ADD CONSTRAINT "department_leaders_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_departments" ADD CONSTRAINT "position_departments_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_departments" ADD CONSTRAINT "position_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_positions" ADD CONSTRAINT "user_positions_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_items" ADD CONSTRAINT "overtime_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_change_requests" ADD CONSTRAINT "position_change_requests_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 补充：部分唯一索引与 CHECK 约束
-- （Prisma schema 不表达这些 PostgreSQL 能力，按 docs/database-design 逐条落地）
-- ============================================================

-- H-1 org_meta：恒为单行
ALTER TABLE "hr"."org_meta" ADD CONSTRAINT "org_meta_single_row_check" CHECK (id = 1);

-- H-10：同一员工同时最多一条待审批岗位申请
CREATE UNIQUE INDEX "approval_requests_position_change_pending_unique" ON "hr"."approval_requests" ("applicant_id") WHERE request_type = 'POSITION_CHANGE' AND status = 'PENDING';

-- H-12 overtime_items：加班时间分钟范围校验（0 <= start < end <= 1440）
ALTER TABLE "hr"."overtime_items" ADD CONSTRAINT "overtime_items_start_minute_check" CHECK (start_minute >= 0);
ALTER TABLE "hr"."overtime_items" ADD CONSTRAINT "overtime_items_minute_range_check" CHECK (start_minute < end_minute);
ALTER TABLE "hr"."overtime_items" ADD CONSTRAINT "overtime_items_end_minute_check" CHECK (end_minute <= 1440);

-- H-17 幂等唯一约束（与 base/backstage 操作日志同构）：操作者 + 作用域 + 幂等键，系统操作以 0 兜底
CREATE UNIQUE INDEX "operation_logs_idempotency_unique" ON "hr"."operation_logs" (COALESCE(operator_id, 0), system, idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- H-18 user_table_prefs：同一页面同名预设唯一；每页一条列设置
CREATE UNIQUE INDEX "user_table_prefs_preset_unique" ON "hr"."user_table_prefs" ("user_id", "page_key", "name") WHERE pref_type = 'FILTER_PRESET';
CREATE UNIQUE INDEX "user_table_prefs_column_unique" ON "hr"."user_table_prefs" ("user_id", "page_key") WHERE pref_type = 'COLUMN_SETTING';
