-- backstage 用户账号只读视图（主 PRD §9.4、backstage PRD §3，T6-8）
-- 拥有模块：backstage（platform-core）；hr/asset 会话加载、姓名快照、在职校验、
-- 恢复兼容性检查（lifecycle_version 比对，须读已注销用户）经此视图读取，
-- 替代对 base.users 的直连。
-- 视图包含全部用户（含软删），deleted_at 列由消费方按场景过滤：
--   会话加载/在职校验：deleted_at IS NOT NULL 视为不存在；恢复兼容：注销用户亦须可查。
-- 幂等：CREATE OR REPLACE VIEW，由 Migration Runner 在全部部署单元迁移完成后统一执行。

CREATE OR REPLACE VIEW "backstage"."user_accounts" AS
SELECT
    id                AS user_id,
    name,
    status,
    is_super_admin,
    session_version,
    lifecycle_version,
    deleted_at
FROM "base"."users";
