-- 新增安全日志事件枚举值 DINGTALK_BOUND（已登录用户自助绑定钉钉，base PRD §2/§8）。
-- PG ≥ 12 允许 ALTER TYPE ... ADD VALUE 位于事务内（同事务不使用新值即可）。
ALTER TYPE "backstage"."SecurityEventType" ADD VALUE 'DINGTALK_BOUND';
