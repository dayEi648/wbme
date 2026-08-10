-- hr 用户组织关系只读视图（主 PRD §9.4、hr PRD §5，T6-6）
-- 拥有模块：hr。
--   user_org：用户当前组织关系（每"用户×部门"一行，多部门并列；岗位为单值外连接，
--     多部门员工各行的岗位重复——查询时取一次即可）。含 DISABLED 部门与停用岗位：
--     停用不改变既有组织关系与历史范围（hr PRD §6/§7）。
--   org_version：组织版本单行（user_org_version / org_tree_version）。
--     供 base PRD §3 的守卫四版本授权上下文缓存校验读取。
-- 幂等：CREATE OR REPLACE VIEW，由 Migration Runner 统一执行。

CREATE OR REPLACE VIEW "hr"."user_org" AS
SELECT
    ud.user_id,
    ud.department_id,
    d.name  AS department_name,
    up.position_id,
    p.name  AS position_name,
    p.status AS position_status
FROM "hr"."user_departments" ud
INNER JOIN "hr"."departments" d ON d.id = ud.department_id
LEFT JOIN "hr"."user_positions" up ON up.user_id = ud.user_id
LEFT JOIN "hr"."positions" p ON p.id = up.position_id;

CREATE OR REPLACE VIEW "hr"."org_version" AS
SELECT
    user_org_version,
    org_tree_version,
    updated_at
FROM "hr"."org_meta";
