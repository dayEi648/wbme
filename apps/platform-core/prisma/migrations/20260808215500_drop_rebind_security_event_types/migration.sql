-- 删除换绑（rebind）功能残留的安全日志事件枚举值（base PRD §8 事件清单随实现维护）。
-- PG 的 ALTER TYPE ... DROP VALUE 不能位于事务块内（Prisma 迁移在事务中执行），
-- 故采用标准重建方案：建新枚举 → 列类型转换 → 删旧枚举 → 改名（全程事务兼容，无数据迁移）。
CREATE TYPE "backstage"."SecurityEventType_new" AS ENUM (
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'LOGOUT',
  'ACCOUNT_LOCK',
  'ACCOUNT_UNLOCK',
  'IP_LOCK',
  'IP_UNLOCK',
  'ACCOUNT_ACTIVATED',
  'INVITATION_ISSUED',
  'INVITATION_USED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET_ISSUED',
  'PASSWORD_RESET_COMPLETED',
  'PHONE_SYNCED',
  'PHONE_SYNC_CONFLICT',
  'INTERNAL_TOKEN_FAILED'
);

ALTER TABLE "backstage"."security_logs"
  ALTER COLUMN event_type TYPE "backstage"."SecurityEventType_new"
  USING event_type::text::"backstage"."SecurityEventType_new";

DROP TYPE "backstage"."SecurityEventType";

ALTER TYPE "backstage"."SecurityEventType_new" RENAME TO "SecurityEventType";
