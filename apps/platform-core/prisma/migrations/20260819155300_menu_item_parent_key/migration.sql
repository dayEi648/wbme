-- S-22 结构变更：菜单项分组归属由 group_key/sub_group_key（固定两级）改为单列 parent_key（直接父分组 node_key，NULL=顶层叶子）。
-- 配合菜单管理放开任意层级嵌套：分组可自由嵌套、菜单项可挂在任意层级。
-- 两列语义无法无损合并为单列（sub_group_key 单独存在时 group_key 必为空，反之同理，
-- 合并应取 COALESCE(sub_group_key, group_key)），且 dev 库当前无数据，直接删列重建。
ALTER TABLE "backstage"."system_menu_items" DROP COLUMN "group_key",
DROP COLUMN "sub_group_key",
ADD COLUMN "parent_key" TEXT;
