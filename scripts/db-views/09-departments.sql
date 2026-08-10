-- hr 部门只读视图（主 PRD §9.4、M11）
-- 拥有模块：hr。部门为业务表（H-2，物理删除、name 可改）；
-- asset 等跨模块读部门名称经本视图，不直连业务表。
-- 幂等：CREATE OR REPLACE VIEW，由 Migration Runner 统一执行。

CREATE OR REPLACE VIEW "hr"."departments_view" AS
SELECT
    id,
    name,
    status
FROM "hr"."departments";
