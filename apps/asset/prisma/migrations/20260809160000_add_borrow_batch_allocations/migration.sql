-- A-23-1：保存每条借还记录实际借出的批次，确保归还只能回到原批次。
CREATE TABLE "asset"."borrow_batch_allocations" (
    "id" SERIAL NOT NULL,
    "borrow_record_id" INTEGER NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "issued_qty" INTEGER NOT NULL,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "borrow_batch_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "borrow_batch_allocations_issued_qty_check" CHECK ("issued_qty" > 0),
    CONSTRAINT "borrow_batch_allocations_returned_qty_check" CHECK ("returned_qty" >= 0 AND "returned_qty" <= "issued_qty")
);

CREATE UNIQUE INDEX "borrow_batch_allocations_borrow_record_id_batch_id_key"
    ON "asset"."borrow_batch_allocations" ("borrow_record_id", "batch_id");
CREATE INDEX "borrow_batch_allocations_batch_id_idx"
    ON "asset"."borrow_batch_allocations" ("batch_id");

ALTER TABLE "asset"."borrow_batch_allocations"
    ADD CONSTRAINT "borrow_batch_allocations_borrow_record_id_fkey"
    FOREIGN KEY ("borrow_record_id") REFERENCES "asset"."borrow_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset"."borrow_batch_allocations"
    ADD CONSTRAINT "borrow_batch_allocations_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "asset"."batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 为已有记录从对应申请的出库流水回填。历史已归还数量按最后出库先归还（LIFO）分配，
-- 使后续归还只会使用尚未归还的原始批次份额。
WITH issued AS (
    SELECT
        br.id AS borrow_record_id,
        sf.batch_id,
        sf.qty AS issued_qty,
        br.returned_qty,
        COALESCE(
            SUM(sf.qty) OVER (
                PARTITION BY br.id
                ORDER BY sf.id DESC
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ),
            0
        ) AS returned_before
    FROM "asset"."borrow_records" br
    INNER JOIN "asset"."stock_flows" sf
        ON sf.ref_id = br.request_id
        AND sf.inventory_item_id = br.inventory_item_id
        AND sf.direction = 'OUT'
        AND sf.batch_id IS NOT NULL
        AND (
            (br.record_type = 'PERSONAL' AND sf.ref_type = 'CONSUMABLE_REQUEST')
            OR (br.record_type = 'AGENT' AND sf.ref_type = 'AGENT_REQUEST')
        )
)
INSERT INTO "asset"."borrow_batch_allocations" (
    "borrow_record_id", "batch_id", "issued_qty", "returned_qty"
)
SELECT
    borrow_record_id,
    batch_id,
    issued_qty,
    LEAST(issued_qty, GREATEST(returned_qty - returned_before, 0))
FROM issued
ON CONFLICT ("borrow_record_id", "batch_id") DO NOTHING;
