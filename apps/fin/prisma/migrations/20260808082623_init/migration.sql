-- CreateEnum
CREATE TYPE "AmountSemantic" AS ENUM ('TENTATIVE', 'AUDITED');

-- CreateEnum
CREATE TYPE "ProjectAction" AS ENUM ('CREATE', 'EDIT', 'DELETE', 'IMPORT_CREATE', 'IMPORT_OVERWRITE', 'IMPORT_SKIP');

-- CreateEnum
CREATE TYPE "FinanceDictType" AS ENUM ('PROGRESS', 'COMPLETENESS', 'BIZ_CATEGORY', 'REGION');

-- CreateEnum
CREATE TYPE "DictStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "LogAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'EXPORT');

-- CreateEnum
CREATE TYPE "TablePrefType" AS ENUM ('FILTER_PRESET', 'COLUMN_SETTING');

-- CreateEnum
CREATE TYPE "SettingValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateTable
CREATE TABLE "projects" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "business_key" TEXT NOT NULL,
    "completeness_docs" JSONB,
    "region_id" INTEGER,
    "region_name" TEXT,
    "progress_id" INTEGER,
    "progress_name" TEXT,
    "progress_semantic" "AmountSemantic",
    "biz_category_id" INTEGER,
    "biz_category_name" TEXT,
    "party_a" TEXT,
    "general_contractor" TEXT,
    "management_fee" TEXT,
    "subcontractors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contract_start_date" DATE,
    "contract_end_date" DATE,
    "contract_amount" DECIMAL(18,2),
    "payment_node" TEXT,
    "tentative_audited_amount" DECIMAL(18,2),
    "settlement" DECIMAL(18,2),
    "misc_expense" DECIMAL(18,2),
    "remark" TEXT,
    "data_revision" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_by" INTEGER,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "occurred_date" DATE,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "occurred_date" DATE,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_payments" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "occurred_date" DATE,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subcontract_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_operations" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "operator_id" INTEGER NOT NULL,
    "operator_name" TEXT NOT NULL,
    "action" "ProjectAction" NOT NULL,
    "field" TEXT,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_dict_items" (
    "id" SERIAL NOT NULL,
    "dict_type" "FinanceDictType" NOT NULL,
    "name" TEXT NOT NULL,
    "semantic" "AmountSemantic",
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" "DictStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_dict_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_settings" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "SettingValueType" NOT NULL,
    "label" TEXT NOT NULL,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "projects_business_key_year_key" ON "projects"("business_key", "year");

-- CreateIndex
CREATE INDEX "invoices_project_id_idx" ON "invoices"("project_id");

-- CreateIndex
CREATE INDEX "receipts_project_id_idx" ON "receipts"("project_id");

-- CreateIndex
CREATE INDEX "subcontract_payments_project_id_idx" ON "subcontract_payments"("project_id");

-- CreateIndex
CREATE INDEX "project_operations_project_id_created_at_idx" ON "project_operations"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "project_operations_created_at_idx" ON "project_operations"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "finance_dict_items_dict_type_name_key" ON "finance_dict_items"("dict_type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "finance_settings_key_key" ON "finance_settings"("key");

-- CreateIndex
CREATE INDEX "operation_logs_system_created_at_idx" ON "operation_logs"("system", "created_at");

-- CreateIndex
CREATE INDEX "operation_logs_operator_id_created_at_idx" ON "operation_logs"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "user_table_prefs_user_id_page_key_idx" ON "user_table_prefs"("user_id", "page_key");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_payments" ADD CONSTRAINT "subcontract_payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_operations" ADD CONSTRAINT "project_operations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 补充：部分唯一索引与 CHECK 约束（Prisma schema 无法表达，见 docs/database-design/fin.md）
-- F-1 projects：四位公历年 CHECK；手工金额 >= 0（主 PRD §9.11，允许 0）
ALTER TABLE "fin"."projects" ADD CONSTRAINT "projects_year_check" CHECK (year BETWEEN 1000 AND 9999);
ALTER TABLE "fin"."projects" ADD CONSTRAINT "projects_contract_amount_check" CHECK (contract_amount >= 0);
ALTER TABLE "fin"."projects" ADD CONSTRAINT "projects_tentative_audited_amount_check" CHECK (tentative_audited_amount >= 0);
ALTER TABLE "fin"."projects" ADD CONSTRAINT "projects_settlement_check" CHECK (settlement >= 0);
ALTER TABLE "fin"."projects" ADD CONSTRAINT "projects_misc_expense_check" CHECK (misc_expense >= 0);

-- F-2 / F-3 / F-4 金额明细：amount >= 0
ALTER TABLE "fin"."invoices" ADD CONSTRAINT "invoices_amount_check" CHECK (amount >= 0);
ALTER TABLE "fin"."receipts" ADD CONSTRAINT "receipts_amount_check" CHECK (amount >= 0);
ALTER TABLE "fin"."subcontract_payments" ADD CONSTRAINT "subcontract_payments_amount_check" CHECK (amount >= 0);

-- F-6 finance_dict_items：PROGRESS 类型必填 semantic
ALTER TABLE "fin"."finance_dict_items" ADD CONSTRAINT "finance_dict_items_semantic_required_check" CHECK (dict_type <> 'PROGRESS' OR semantic IS NOT NULL);

-- F-8 operation_logs：幂等部分唯一索引（COALESCE 以 0 兜底系统操作，NULL 幂等键不参与）
CREATE UNIQUE INDEX "operation_logs_idempotency_unique" ON "fin"."operation_logs" (COALESCE(operator_id, 0), system, idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- F-9 user_table_prefs：筛选预设同名唯一；每页一条列设置
CREATE UNIQUE INDEX "user_table_prefs_preset_unique" ON "fin"."user_table_prefs" ("user_id", "page_key", "name") WHERE pref_type = 'FILTER_PRESET';
CREATE UNIQUE INDEX "user_table_prefs_column_unique" ON "fin"."user_table_prefs" ("user_id", "page_key") WHERE pref_type = 'COLUMN_SETTING';
