-- backstage 平台设置只读视图（主 PRD §9.4、§10.3，T6-6）
-- 拥有模块：backstage（platform-core）；asset/hr/fin 读取平台级运行参数
-- （如 export.max.rows 单次导出最大行数）经此视图，替代对 backstage.system_settings 的直连。
-- 只暴露 key/value/value_type：敏感设置（sensitive=true）不进入本视图。
-- 幂等：CREATE OR REPLACE VIEW，由 Migration Runner 统一执行。

CREATE OR REPLACE VIEW "backstage"."platform_settings" AS
SELECT
    key,
    value,
    value_type
FROM "backstage"."system_settings"
WHERE sensitive = false;
