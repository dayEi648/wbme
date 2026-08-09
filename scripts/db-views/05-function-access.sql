-- backstage 功能授权只读视图（主 PRD §9.4、§3.1，T6-8）
-- 拥有模块：backstage（platform-core）；hr/asset 的 getFunctionAccess 经此读取
-- 功能注册（含系统开放状态）与员工授权（含数据范围），替代对
-- backstage.functions / backstage.systems / backstage.employee_grants 的直连。
-- 幂等：CREATE OR REPLACE VIEW，由 Migration Runner 统一执行。

-- 功能注册表：功能编码 → 系统编码/名称/产品状态（函数所属系统开放才可访问）
CREATE OR REPLACE VIEW "backstage"."function_registry" AS
SELECT
    f.code,
    s.code       AS system_code,
    s.name       AS system_name,
    s.product_status
FROM "backstage"."functions" f
INNER JOIN "backstage"."systems" s ON s.id = f.system_id;

-- 员工功能授权（数据范围档位；多档位按最宽范围生效由应用层计算）
CREATE OR REPLACE VIEW "backstage"."function_grants" AS
SELECT
    user_id,
    function_code,
    data_scope
FROM "backstage"."employee_grants";
