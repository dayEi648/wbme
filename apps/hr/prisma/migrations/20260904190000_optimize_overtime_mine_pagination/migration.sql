-- 个人加班记录按员工、日期和 id 稳定分页，先建新索引再删除旧索引以避免迁移窗口退化。
CREATE INDEX "overtime_items_user_id_overtime_date_id_idx"
ON "hr"."overtime_items"("user_id", "overtime_date" DESC, "id" DESC);

DROP INDEX "hr"."overtime_items_user_id_overtime_date_idx";
