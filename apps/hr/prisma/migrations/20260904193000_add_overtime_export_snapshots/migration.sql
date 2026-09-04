-- 加班报表需在组织调整后仍复现申请时的岗位与补交状态，新增不可变快照列。
ALTER TABLE "hr"."overtime_items"
  ADD COLUMN "position_id_snapshot" INTEGER,
  ADD COLUMN "position_name_snapshot" TEXT,
  ADD COLUMN "is_backfill" BOOLEAN NOT NULL DEFAULT false;

-- 历史数据没有岗位快照，不能伪造历史状态；仅以当前可用岗位补充展示值。
UPDATE "hr"."overtime_items" oi
SET "position_id_snapshot" = up."position_id",
    "position_name_snapshot" = p."name"
FROM "hr"."user_positions" up
LEFT JOIN "hr"."positions" p ON p."id" = up."position_id"
WHERE up."user_id" = oi."user_id";

-- 历史补交状态按提交时刻的北京时间日历日一次性推断，之后只读取固化列。
UPDATE "hr"."overtime_items" oi
SET "is_backfill" = r."submitted_at" IS NOT NULL
  AND oi."overtime_date" < (r."submitted_at" AT TIME ZONE 'Asia/Shanghai')::date
FROM "hr"."approval_requests" r
WHERE r."id" = oi."request_id";

CREATE INDEX "overtime_items_department_snapshot_gin_idx"
ON "hr"."overtime_items" USING GIN ("department_snapshot" jsonb_path_ops);
