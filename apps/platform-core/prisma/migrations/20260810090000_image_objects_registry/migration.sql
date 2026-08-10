-- S-20 image_objects 已正式化图片对象注册表（主 PRD §9.2，M5）：
-- finalize 成功后在注册表登记；下载仅放行已登记正式对象（临时对象无下载通道）。
-- 对象键即主键（幂等登记，重复 finalize 同键 upsert 覆盖）。
-- 注意：必须显式带 backstage schema 前缀——迁移连接走 ?schema=base（迁移元数据落 base），
-- 不带前缀会建到 base，而模型 @@schema("backstage") 运行时访问 backstage.image_objects
-- → relation does not exist（M5 复核修复）
CREATE TABLE "backstage"."image_objects" (
  "object_key" TEXT NOT NULL,
  "owner_user_id" INTEGER NOT NULL,
  "finalized_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "image_objects_pkey" PRIMARY KEY ("object_key")
);
