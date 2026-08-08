-- CreateEnum
CREATE TYPE "DictStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AssetDictType" AS ENUM ('UNIT', 'CHANGE_TYPE', 'SUPPLIER', 'BRAND', 'SPEC', 'ASSET_SPEC', 'ASSET_MODEL');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IDLE', 'IN_USE', 'PENDING_REPAIR', 'REPAIRING', 'SCRAPPED');

-- CreateEnum
CREATE TYPE "AssetOwnership" AS ENUM ('COMPANY', 'PARTNER');

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('PENDING', 'REPAIRING', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "RepairAction" AS ENUM ('REGISTER', 'CANCEL', 'START', 'COMPLETE');

-- CreateEnum
CREATE TYPE "ConsumableType" AS ENUM ('DISPOSABLE', 'REUSABLE');

-- CreateEnum
CREATE TYPE "QuotaCycle" AS ENUM ('MONTH', 'QUARTER', 'YEAR');

-- CreateEnum
CREATE TYPE "StockFlowType" AS ENUM ('STOCK_IN', 'ISSUE', 'DEDUCTION', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'CORRECTION');

-- CreateEnum
CREATE TYPE "FlowDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "ApprovalRequestType" AS ENUM ('STOCK_IN', 'STOCK_CHANGE', 'CONSUMABLE_REQUEST', 'AGENT_REQUEST', 'RETURN', 'WRITE_OFF', 'AGENT_SETTLEMENT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('SUBMIT', 'CANCEL', 'APPROVE', 'REJECT', 'AUTO_CANCEL');

-- CreateEnum
CREATE TYPE "CancelSource" AS ENUM ('USER', 'ACCOUNT_DEACTIVATED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "QuotaType" AS ENUM ('DISPOSABLE_CYCLE', 'REUSABLE_HOLDING');

-- CreateEnum
CREATE TYPE "QuotaStatus" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "BorrowType" AS ENUM ('PERSONAL', 'AGENT');

-- CreateEnum
CREATE TYPE "WriteOffType" AS ENUM ('LOST', 'DAMAGED');

-- CreateEnum
CREATE TYPE "SettleMethod" AS ENUM ('RETURN', 'WRITE_OFF');

-- CreateEnum
CREATE TYPE "DisposalType" AS ENUM ('RETURN', 'WRITE_OFF', 'AGENT_SETTLE');

-- CreateEnum
CREATE TYPE "QrTargetType" AS ENUM ('ASSET', 'INVENTORY_ITEM', 'SCAN_CATALOG');

-- CreateEnum
CREATE TYPE "QrStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SettingValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "LogAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'EXPORT');

-- CreateEnum
CREATE TYPE "TablePrefType" AS ENUM ('FILTER_PRESET', 'COLUMN_SETTING');

-- CreateTable
CREATE TABLE "asset_categories" (
    "id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" "DictStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_dict_items" (
    "id" SERIAL NOT NULL,
    "dict_type" "AssetDictType" NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" "DictStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_dict_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" INTEGER,
    "category_name" TEXT,
    "spec_model" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "purchase_at" DATE,
    "usage_status" "AssetStatus" NOT NULL DEFAULT 'IDLE',
    "ownership" "AssetOwnership" NOT NULL,
    "owner_name" TEXT,
    "department_id" INTEGER,
    "department_name" TEXT,
    "responsible_user_id" INTEGER,
    "responsible_user_name" TEXT,
    "current_user_id" INTEGER,
    "current_user_name" TEXT,
    "image_oss_key" TEXT,
    "remark" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_by" INTEGER,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_transfers" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "from_department_id" INTEGER,
    "from_department_name" TEXT,
    "to_department_id" INTEGER,
    "to_department_name" TEXT,
    "from_user_id" INTEGER,
    "from_user_name" TEXT,
    "to_user_id" INTEGER,
    "to_user_name" TEXT,
    "operator_id" INTEGER NOT NULL,
    "operator_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_changes" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "operator_id" INTEGER NOT NULL,
    "operator_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_orders" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "status" "RepairStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "fault_description" TEXT NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL,
    "pre_status" "AssetStatus" NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "result" TEXT,
    "actual_cost" DECIMAL(18,2),
    "post_status" "AssetStatus",
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repair_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_order_actions" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "action" "RepairAction" NOT NULL,
    "from_status" "RepairStatus" NOT NULL,
    "to_status" "RepairStatus" NOT NULL,
    "operator_id" INTEGER NOT NULL,
    "operator_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_order_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumables" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" INTEGER,
    "category_name" TEXT,
    "unit_id" INTEGER,
    "unit_name" TEXT NOT NULL,
    "type" "ConsumableType" NOT NULL,
    "quota_cycle" "QuotaCycle",
    "quota_limit" INTEGER,
    "return_days" INTEGER,
    "max_holding" INTEGER,
    "reference_price" DECIMAL(18,2),
    "safety_stock" INTEGER NOT NULL DEFAULT 0,
    "image_oss_key" TEXT,
    "remark" TEXT,
    "status" "DictStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consumables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" "DictStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" SERIAL NOT NULL,
    "consumable_id" INTEGER NOT NULL,
    "spec" TEXT NOT NULL,
    "warehouse_id" INTEGER,
    "warehouse_name" TEXT NOT NULL,
    "warehouse_path" TEXT NOT NULL,
    "book_qty" INTEGER NOT NULL DEFAULT 0,
    "reserved_qty" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" SERIAL NOT NULL,
    "inventory_item_id" INTEGER NOT NULL,
    "source_batch_id" INTEGER,
    "consumable_id" INTEGER NOT NULL,
    "consumable_name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "warehouse_path" TEXT NOT NULL,
    "supplier_id" INTEGER,
    "supplier_name" TEXT,
    "brand_id" INTEGER,
    "brand_name" TEXT,
    "unit_price" DECIMAL(18,2),
    "remark" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "remaining_qty" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_corrections" (
    "id" SERIAL NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "operator_id" INTEGER NOT NULL,
    "operator_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_flows" (
    "id" SERIAL NOT NULL,
    "flow_type" "StockFlowType" NOT NULL,
    "direction" "FlowDirection" NOT NULL,
    "inventory_item_id" INTEGER NOT NULL,
    "batch_id" INTEGER,
    "consumable_name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "warehouse_path" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "book_before" INTEGER NOT NULL,
    "book_after" INTEGER NOT NULL,
    "ref_type" TEXT,
    "ref_id" INTEGER,
    "operator_id" INTEGER NOT NULL,
    "operator_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transfers" (
    "id" SERIAL NOT NULL,
    "from_inventory_item_id" INTEGER NOT NULL,
    "to_inventory_item_id" INTEGER NOT NULL,
    "from_warehouse_name" TEXT NOT NULL,
    "from_warehouse_path" TEXT NOT NULL,
    "to_warehouse_name" TEXT NOT NULL,
    "to_warehouse_path" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "remark" TEXT,
    "operator_id" INTEGER NOT NULL,
    "operator_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_batch_items" (
    "id" SERIAL NOT NULL,
    "transfer_id" INTEGER NOT NULL,
    "source_batch_id" INTEGER NOT NULL,
    "target_batch_id" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "transfer_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" SERIAL NOT NULL,
    "application_no" TEXT NOT NULL,
    "request_type" "ApprovalRequestType" NOT NULL,
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
CREATE TABLE "stock_in_items" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "consumable_id" INTEGER NOT NULL,
    "consumable_name" TEXT NOT NULL,
    "supplier_id" INTEGER,
    "supplier_name" TEXT,
    "brand_id" INTEGER,
    "brand_name" TEXT,
    "spec" TEXT NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "warehouse_path" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(18,2),
    "received_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_in_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_change_items" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "inventory_item_id" INTEGER NOT NULL,
    "consumable_name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "warehouse_path" TEXT NOT NULL,
    "change_type_id" INTEGER,
    "change_type_name" TEXT,
    "reason" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_change_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumable_request_items" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "inventory_item_id" INTEGER NOT NULL,
    "consumable_name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "warehouse_path" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "purpose" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumable_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_recipients" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "user_name" TEXT NOT NULL,
    "department_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_occupations" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "consumable_id" INTEGER NOT NULL,
    "consumable_name" TEXT NOT NULL,
    "quota_type" "QuotaType" NOT NULL,
    "cycle" "QuotaCycle",
    "cycle_key" TEXT,
    "request_id" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "status" "QuotaStatus" NOT NULL DEFAULT 'RESERVED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_occupations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "borrow_records" (
    "id" SERIAL NOT NULL,
    "record_type" "BorrowType" NOT NULL,
    "user_id" INTEGER,
    "user_name" TEXT,
    "department_snapshot" JSONB,
    "agent_request_id" INTEGER,
    "request_id" INTEGER NOT NULL,
    "inventory_item_id" INTEGER NOT NULL,
    "consumable_name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "warehouse_path" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "borrowed_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,
    "written_off_qty" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "borrow_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "borrow_action_items" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "borrow_record_id" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "write_off_type" "WriteOffType",
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "borrow_action_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_settlement_items" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "borrow_record_id" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "method" "SettleMethod" NOT NULL,
    "write_off_type" "WriteOffType",
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_settlement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "direct_disposal_records" (
    "id" SERIAL NOT NULL,
    "disposal_type" "DisposalType" NOT NULL,
    "borrow_record_id" INTEGER,
    "agent_request_id" INTEGER,
    "user_id" INTEGER,
    "user_name" TEXT,
    "department_snapshot" JSONB,
    "inventory_item_id" INTEGER NOT NULL,
    "consumable_name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "warehouse_path" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "write_off_type" "WriteOffType",
    "reason" TEXT,
    "processor_id" INTEGER NOT NULL,
    "processor_name" TEXT NOT NULL,
    "stock_flow_refs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "direct_disposal_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_codes" (
    "id" SERIAL NOT NULL,
    "public_id" TEXT NOT NULL,
    "target_type" "QrTargetType" NOT NULL,
    "target_id" INTEGER,
    "status" "QrStatus" NOT NULL DEFAULT 'ACTIVE',
    "revoked_at" TIMESTAMP(3),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_settings" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "SettingValueType" NOT NULL,
    "label" TEXT NOT NULL,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_settings_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "asset_dict_items_dict_type_name_key" ON "asset_dict_items"("dict_type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "consumables_name_key" ON "consumables"("name");

-- CreateIndex
CREATE INDEX "batches_inventory_item_id_idx" ON "batches"("inventory_item_id");

-- CreateIndex
CREATE INDEX "batches_source_batch_id_idx" ON "batches"("source_batch_id");

-- CreateIndex
CREATE INDEX "stock_flows_inventory_item_id_created_at_idx" ON "stock_flows"("inventory_item_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_flows_batch_id_idx" ON "stock_flows"("batch_id");

-- CreateIndex
CREATE INDEX "stock_flows_ref_type_ref_id_idx" ON "stock_flows"("ref_type", "ref_id");

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
CREATE UNIQUE INDEX "stock_in_items_request_id_consumable_id_spec_warehouse_id_key" ON "stock_in_items"("request_id", "consumable_id", "spec", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_change_items_request_id_inventory_item_id_key" ON "stock_change_items"("request_id", "inventory_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "consumable_request_items_request_id_inventory_item_id_key" ON "consumable_request_items"("request_id", "inventory_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_recipients_request_id_user_id_key" ON "agent_recipients"("request_id", "user_id");

-- CreateIndex
CREATE INDEX "quota_occupations_user_id_consumable_id_cycle_key_idx" ON "quota_occupations"("user_id", "consumable_id", "cycle_key");

-- CreateIndex
CREATE INDEX "borrow_records_user_id_idx" ON "borrow_records"("user_id");

-- CreateIndex
CREATE INDEX "borrow_records_agent_request_id_idx" ON "borrow_records"("agent_request_id");

-- CreateIndex
CREATE INDEX "borrow_records_created_at_idx" ON "borrow_records"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "borrow_action_items_request_id_borrow_record_id_key" ON "borrow_action_items"("request_id", "borrow_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_settlement_items_request_id_borrow_record_id_method_key" ON "agent_settlement_items"("request_id", "borrow_record_id", "method");

-- CreateIndex
CREATE UNIQUE INDEX "qr_codes_public_id_key" ON "qr_codes"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_settings_key_key" ON "asset_settings"("key");

-- CreateIndex
CREATE INDEX "operation_logs_system_created_at_idx" ON "operation_logs"("system", "created_at");

-- CreateIndex
CREATE INDEX "operation_logs_operator_id_created_at_idx" ON "operation_logs"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "user_table_prefs_user_id_page_key_idx" ON "user_table_prefs"("user_id", "page_key");

-- AddForeignKey
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "asset_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_transfers" ADD CONSTRAINT "asset_transfers_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_changes" ADD CONSTRAINT "asset_changes_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_order_actions" ADD CONSTRAINT "repair_order_actions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "repair_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_consumable_id_fkey" FOREIGN KEY ("consumable_id") REFERENCES "consumables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_corrections" ADD CONSTRAINT "batch_corrections_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_batch_items" ADD CONSTRAINT "transfer_batch_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "inventory_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_in_items" ADD CONSTRAINT "stock_in_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_change_items" ADD CONSTRAINT "stock_change_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_request_items" ADD CONSTRAINT "consumable_request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_recipients" ADD CONSTRAINT "agent_recipients_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrow_action_items" ADD CONSTRAINT "borrow_action_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrow_action_items" ADD CONSTRAINT "borrow_action_items_borrow_record_id_fkey" FOREIGN KEY ("borrow_record_id") REFERENCES "borrow_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_settlement_items" ADD CONSTRAINT "agent_settlement_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_settlement_items" ADD CONSTRAINT "agent_settlement_items_borrow_record_id_fkey" FOREIGN KEY ("borrow_record_id") REFERENCES "borrow_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 补充：部分唯一索引与 CHECK 约束
-- （Prisma schema 不表达这些 PostgreSQL 能力，按 docs/database-design/asset.md 逐条落地）
-- ============================================================

-- A-1 asset_categories：同一顶级分类下名称唯一（NULL 不参与唯一比较，COALESCE 兜底）
CREATE UNIQUE INDEX "asset_categories_parent_name_unique" ON "asset"."asset_categories" (COALESCE(parent_id, 0), name);

-- A-6 repair_orders：同一资产最多一张进行中维修单（PENDING/REPAIRING）
CREATE UNIQUE INDEX "repair_orders_asset_active_unique" ON "asset"."repair_orders" ("asset_id") WHERE status IN ('PENDING', 'REPAIRING');

-- A-8 consumables：一次性用品必须配置周期与上限；借还用品必须配置归还期限与持有上限
ALTER TABLE "asset"."consumables" ADD CONSTRAINT "consumables_disposable_quota_check" CHECK (type <> 'DISPOSABLE' OR (quota_cycle IS NOT NULL AND quota_limit IS NOT NULL));
ALTER TABLE "asset"."consumables" ADD CONSTRAINT "consumables_reusable_terms_check" CHECK (type <> 'REUSABLE' OR (return_days IS NOT NULL AND max_holding IS NOT NULL));

-- A-10 inventory_items：账面/占用非负且占用不超账面
ALTER TABLE "asset"."inventory_items" ADD CONSTRAINT "inventory_items_qty_check" CHECK (book_qty >= 0 AND reserved_qty >= 0 AND reserved_qty <= book_qty);
-- A-10 inventory_items：同品种"规格+库位"合并为一个条目
CREATE UNIQUE INDEX "inventory_items_consumable_spec_warehouse_unique" ON "asset"."inventory_items" ("consumable_id", "spec", COALESCE(warehouse_id, 0));

-- A-11 batches：剩余数量非负
ALTER TABLE "asset"."batches" ADD CONSTRAINT "batches_remaining_qty_check" CHECK (remaining_qty >= 0);

-- A-13 stock_flows：变动数量为正、变动前后账面非负
ALTER TABLE "asset"."stock_flows" ADD CONSTRAINT "stock_flows_qty_check" CHECK (qty > 0 AND book_before >= 0 AND book_after >= 0);

-- A-14 inventory_transfers：调拨数量为正
ALTER TABLE "asset"."inventory_transfers" ADD CONSTRAINT "inventory_transfers_qty_check" CHECK (qty > 0);

-- A-15 transfer_batch_items：段移动数量为正
ALTER TABLE "asset"."transfer_batch_items" ADD CONSTRAINT "transfer_batch_items_qty_check" CHECK (qty > 0);

-- A-16 approval_requests：同一代领清单最多一条待审批结清申请
CREATE UNIQUE INDEX "approval_requests_agent_settlement_pending_unique" ON "asset"."approval_requests" ("ref_request_id") WHERE request_type = 'AGENT_SETTLEMENT' AND status = 'PENDING';

-- A-18 stock_in_items：数量为正
ALTER TABLE "asset"."stock_in_items" ADD CONSTRAINT "stock_in_items_qty_check" CHECK (qty > 0);

-- A-19 stock_change_items：数量为正
ALTER TABLE "asset"."stock_change_items" ADD CONSTRAINT "stock_change_items_qty_check" CHECK (qty > 0);

-- A-20 consumable_request_items：数量为正
ALTER TABLE "asset"."consumable_request_items" ADD CONSTRAINT "consumable_request_items_qty_check" CHECK (qty > 0);

-- A-22 quota_occupations：占用数量为正
ALTER TABLE "asset"."quota_occupations" ADD CONSTRAINT "quota_occupations_qty_check" CHECK (qty > 0);

-- A-23 borrow_records：借出数量为正、已归还+已核销不超借出数量
ALTER TABLE "asset"."borrow_records" ADD CONSTRAINT "borrow_records_qty_check" CHECK (qty > 0 AND returned_qty + written_off_qty <= qty);

-- A-24 borrow_action_items：数量为正
ALTER TABLE "asset"."borrow_action_items" ADD CONSTRAINT "borrow_action_items_qty_check" CHECK (qty > 0);

-- A-25 agent_settlement_items：数量为正
ALTER TABLE "asset"."agent_settlement_items" ADD CONSTRAINT "agent_settlement_items_qty_check" CHECK (qty > 0);

-- A-27 qr_codes：目标同时最多一张有效/停用二维码（作废并重新生成创建新行）
CREATE UNIQUE INDEX "qr_codes_target_active_unique" ON "asset"."qr_codes" ("target_type", COALESCE(target_id, 0)) WHERE status <> 'REVOKED';
