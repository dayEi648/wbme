-- hr 部门闭包只读视图（主 PRD §9.4、hr PRD §5/§6，T6-6）
-- 拥有模块：hr。递归 CTE 展开"部门及全部下级"（含自身），供审批中心 DEPARTMENT 档
-- 数据范围过滤、代交加班范围、岗位申请审批范围、platform-core 操作日志部门过滤查询。
-- 闭包是结构事实：ACTIVE 与 DISABLED 部门全部参与——部门停用不得收缩既有数据范围
-- （hr PRD §6），停用只影响"新选择目标"（应用层按 ACTIVE 过滤，两套逻辑分离）。
-- UNION 去重 + 路径数组防环：节点已在当前展开路径中即停止下钻（脏数据循环链
-- 不会导致无限递归）；不使用深度上限，部门树深度超过 20 层时闭包同样完整。
-- 幂等：CREATE OR REPLACE VIEW，由 Migration Runner 统一执行。

CREATE OR REPLACE VIEW "hr"."department_closure" AS
WITH RECURSIVE closure AS (
    SELECT id AS ancestor_id, id AS descendant_id, ARRAY[id] AS path
    FROM "hr"."departments"
    UNION
    SELECT c.ancestor_id, d.id AS descendant_id, c.path || d.id
    FROM closure c
    INNER JOIN "hr"."departments" d ON d.parent_id = c.descendant_id
    WHERE NOT (d.id = ANY(c.path))
)
SELECT DISTINCT ancestor_id, descendant_id
FROM closure;
