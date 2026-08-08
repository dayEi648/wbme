-- users.name 长度上限 50（表设计 docs/database-design/base.md B-1 约束列「≤50」）。
-- 此前仅在 DTO 层以 @MaxLength(50) 约束，本迁移落库级 CHECK（手写补充，同
-- users_active_password_check 的既有写法：users 表位于默认 schema base，迁移经 ?schema=base 执行）。
ALTER TABLE "users" ADD CONSTRAINT "users_name_length_check" CHECK (char_length(name) <= 50);
