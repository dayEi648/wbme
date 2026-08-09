-- A-30 user_table_prefs：补齐部分唯一索引（与 base/hr/fin 同构表一致）
-- FILTER_PRESET：同页面同名预设唯一；COLUMN_SETTING：每页一条列设置
CREATE UNIQUE INDEX "user_table_prefs_preset_unique" ON "asset"."user_table_prefs" ("user_id", "page_key", "name") WHERE pref_type = 'FILTER_PRESET';
CREATE UNIQUE INDEX "user_table_prefs_column_unique" ON "asset"."user_table_prefs" ("user_id", "page_key") WHERE pref_type = 'COLUMN_SETTING';
