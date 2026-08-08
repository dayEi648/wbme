-- hr 用户当前职称只读视图（主 PRD §9.4、hr PRD §8）
-- 拥有模块：hr。当前职称是规则计算得到的派生值：
--   1) 取全部启用且未软删除的职称规则；
--   2) 规则中填写的全部非空条件须同时成立：部门条件对多部门员工"任一当前所属部门命中即匹配"，
--      岗位与站点角色按当前唯一值匹配（站点角色经 backstage.site_roles 视图读取）；
--   3) 命中多条时按"非空匹配条件数量更多 → 排序值更小 → 规则 ID 更小"确定唯一职称；
--   4) 没有规则命中时职称为 NULL（不阻止账号/组织正常保存）。
-- 组织、角色或规则变更后下一次查询立即得到新结果，不需要跨服务同步任务或人工重新计算。
-- 幂等：CREATE OR REPLACE VIEW，由 Migration Runner 统一执行。

CREATE OR REPLACE VIEW "hr"."user_titles" AS
WITH users AS (
    SELECT user_id, name, is_super_admin
    FROM "backstage"."site_roles"
),
user_depts AS (
    SELECT user_id, department_id
    FROM "hr"."user_departments"
),
user_pos AS (
    SELECT user_id, position_id
    FROM "hr"."user_positions"
    WHERE position_id IS NOT NULL
),
active_rules AS (
    SELECT id, title_name, department_id, position_id, role_condition, sort
    FROM "hr"."title_rules"
    WHERE status = 'ACTIVE' AND deleted_at IS NULL
),
matches AS (
    SELECT
        u.user_id,
        r.id AS rule_id,
        r.title_name,
        r.sort,
        -- 规则声明的非空条件总数（匹配度分母）
        (CASE WHEN r.department_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN r.position_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN r.role_condition IS NOT NULL THEN 1 ELSE 0 END) AS conditions_count,
        -- 实际命中的条件数
        (CASE WHEN r.department_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM user_depts d WHERE d.user_id = u.user_id AND d.department_id = r.department_id
         ) THEN 1 ELSE 0 END
         + CASE WHEN r.position_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM user_pos p WHERE p.user_id = u.user_id AND p.position_id = r.position_id
         ) THEN 1 ELSE 0 END
         + CASE WHEN r.role_condition IS NOT NULL AND (
             (r.role_condition = 'SUPER_ADMIN' AND u.is_super_admin)
             OR (r.role_condition = 'EMPLOYEE' AND NOT u.is_super_admin)
         ) THEN 1 ELSE 0 END) AS matched_count
    FROM users u
    CROSS JOIN active_rules r
),
hit AS (
    SELECT
        user_id,
        title_name,
        ROW_NUMBER() OVER (
            PARTITION BY user_id
            ORDER BY matched_count DESC, sort ASC, rule_id ASC
        ) AS rn
    FROM matches
    WHERE conditions_count > 0 AND matched_count = conditions_count
)
SELECT
    u.user_id,
    u.name,
    h.title_name
FROM users u
LEFT JOIN hit h ON h.user_id = u.user_id AND h.rn = 1;
