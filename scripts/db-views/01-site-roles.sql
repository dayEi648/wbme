-- backstage 站点角色只读视图（主 PRD §9.4、backstage PRD §8）
-- 拥有模块：backstage（platform-core）；hr 职称视图等其它模块经此视图读取最小站点角色字段。
-- 幂等：CREATE OR REPLACE VIEW，由 Migration Runner 在全部部署单元迁移完成后统一执行。

CREATE OR REPLACE VIEW "backstage"."site_roles" AS
SELECT
    id           AS user_id,
    name,
    is_super_admin,
    status
FROM "base"."users"
WHERE deleted_at IS NULL;
