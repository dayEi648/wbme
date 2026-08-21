-- S-21/S-22 系统导航菜单展示配置（主 PRD §2.1 菜单管理）：
-- 每个系统的导航排序/分组归属/中文名覆盖，每节点一行；path/permission/默认名仍由前端代码定义。
-- 整树在单事务内 delete+create 替换，表间引用（group_key/sub_group_key → node_key）由应用层维护，不建外键。
-- 注意：必须显式带 backstage schema 前缀——迁移连接走 ?schema=base（迁移元数据落 base），
-- 不带前缀会建到 base，而模型 @@schema("backstage") 运行时访问 backstage.* → relation does not exist。
CREATE TABLE "backstage"."system_menu_groups" (
    "id" SERIAL NOT NULL,
    "system_code" TEXT NOT NULL,
    "node_key" TEXT NOT NULL,
    "parent_key" TEXT,
    "name_override" TEXT,
    "sort_order" INTEGER NOT NULL,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_menu_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "backstage"."system_menu_items" (
    "id" SERIAL NOT NULL,
    "system_code" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "group_key" TEXT,
    "sub_group_key" TEXT,
    "name_override" TEXT,
    "sort_order" INTEGER NOT NULL,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_menu_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_menu_groups_system_code_node_key_key" ON "backstage"."system_menu_groups"("system_code", "node_key");

CREATE UNIQUE INDEX "system_menu_items_system_code_item_key_key" ON "backstage"."system_menu_items"("system_code", "item_key");
