-- 审批头补整单备注列（asset PRD §6：入库/库存变更申请的"整单备注"须持久化并随审批详情展示）。
ALTER TABLE "asset"."approval_requests" ADD COLUMN "remark" TEXT;
