# WBME 数据库表设计：asset 模块

> schema：`asset`，独立部署单元。
> 表结构遵循 `00-baseline.md` 公共基线；跨模块引用（用户、分类、库位等）不建外键，存 ID + 名称/路径快照。
> 配置类数据（分类、库位、品种、字典）物理删除；业务实体（资产、审批申请）软删除；流水/记录类只追加。

## 1. 分类与字典

### A-1 `asset_categories` 分类（物理删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `parent_id` | `integer` | NULL | 顶级分类=NULL（系统内置"固定资产/消耗品"）；业务只维护一级子分类 |
| `name` | `text` | NOT NULL | 分类名称 |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序 |
| `status` | `enum dict_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED` |
| `created_by` / `created_at` | | 基线 §2.1（无 `deleted_*`） | |
| `updated_by` / `updated_at` | | 基线 §2.1（无 `deleted_*`） | |

- 唯一索引：`(COALESCE(parent_id, 0), name)`——同一顶级分类下名称唯一
- 车辆顶级分类本期不提供，后续扩展

### A-2 `asset_dict_items` 业务字典项（物理删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `dict_type` | `enum asset_dict_type` | NOT NULL | `UNIT / CHANGE_TYPE / SUPPLIER / BRAND / SPEC / ASSET_SPEC / ASSET_MODEL` |
| `name` | `text` | NOT NULL | 字典项名称 |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序 |
| `status` | `enum dict_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED` |
| `created_by` / `created_at` | | 基线 §2.1（无 `deleted_*`） | |
| `updated_by` / `updated_at` | | 基线 §2.1（无 `deleted_*`） | |

- 唯一索引：`(dict_type, name)`；库存变更类型仅表示意外扣减原因，不带增减方向

## 2. 固定资产

### A-3 `assets` 固定资产台账（软删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `name` | `text` | NOT NULL | 资产名称 |
| `category_id` | `integer` | NULL | 分类（无外键：删除后历史引用） |
| `category_name` | `text` | NULL | 分类名称快照 |
| `spec_model` | `text` | NULL | 规格型号 |
| `amount` | `numeric(18,2)` | NOT NULL | 金额（必填，元） |
| `purchase_at` | `date` | NULL | 入库时间 |
| `usage_status` | `enum asset_status` | NOT NULL `DEFAULT IDLE` | `IDLE / IN_USE / PENDING_REPAIR / REPAIRING / SCRAPPED` |
| `ownership` | `enum asset_ownership` | NOT NULL | `COMPANY / PARTNER` |
| `owner_name` | `text` | NULL | 归属方名称（合作方所有时） |
| `department_id` | `integer` | NULL | 所属部门（无外键，允许为空；部门删除时置空） |
| `department_name` | `text` | NULL | 部门名称快照 |
| `responsible_user_id` | `integer` | NULL | 责任人 |
| `responsible_user_name` | `text` | NULL | 责任人姓名快照 |
| `current_user_id` | `integer` | NULL | 使用者 |
| `current_user_name` | `text` | NULL | 使用者姓名快照 |
| `image_oss_key` | `text` | NULL | 主图对象标识 |
| `remark` | `text` | NULL | 备注 |
| `created_by` / `created_at` | | 基线 §2.1 | |
| `updated_by` / `updated_at` | | 基线 §2.1 | |
| `deleted_by` / `deleted_at` | | 基线 §2.1 | |

- 已报废是业务状态（继续显示在台账），非删除
- 责任人与所属部门变化必须产生调度记录（A-4），不能普通编辑绕过

### A-4 `asset_transfers` 调度记录（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `asset_id` | `integer` | NOT NULL → `assets.id` | |
| `from_department_id` | `integer` | NULL | 原所属部门 |
| `from_department_name` | `text` | NULL | 原部门名称快照 |
| `to_department_id` | `integer` | NULL | 目标部门 |
| `to_department_name` | `text` | NULL | 目标部门名称快照 |
| `from_user_id` | `integer` | NULL | 原责任人 |
| `from_user_name` | `text` | NULL | 原责任人姓名快照 |
| `to_user_id` | `integer` | NULL | 目标责任人 |
| `to_user_name` | `text` | NULL | 目标责任人姓名快照 |
| `operator_id` | `integer` | NOT NULL | 操作者 |
| `operator_name` | `text` | NOT NULL | 操作者姓名快照 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

### A-5 `asset_changes` 变更记录（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `asset_id` | `integer` | NOT NULL → `assets.id` | |
| `before` | `jsonb` | NOT NULL | 变更前字段值 |
| `after` | `jsonb` | NOT NULL | 变更后字段值 |
| `operator_id` | `integer` | NOT NULL | 操作者 |
| `operator_name` | `text` | NOT NULL | 操作者姓名快照 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

### A-6 `repair_orders` 维修单

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `asset_id` | `integer` | NOT NULL → `assets.id` | |
| `status` | `enum repair_status` | NOT NULL `DEFAULT PENDING` | `PENDING / REPAIRING / CANCELLED / COMPLETED` |
| `version` | `integer` | NOT NULL `DEFAULT 1` | 版本号（状态条件更新） |
| `fault_description` | `text` | NOT NULL | 故障/维修事项 |
| `reported_at` | `timestamptz` | NOT NULL | 报修时间 |
| `pre_status` | `enum asset_status` | NOT NULL | 维修前资产状态快照 |
| `started_at` | `timestamptz` | NULL | 开始维修时间 |
| `completed_at` | `timestamptz` | NULL | 完成时间 |
| `result` | `text` | NULL | 维修结果 |
| `actual_cost` | `numeric(18,2)` | NULL | 实际费用（无费用为 0） |
| `post_status` | `enum asset_status` | NULL | 完成后恢复的资产状态 |
| `created_by` / `created_at` | | 基线 §2.1（无 `deleted_*`） | |
| `updated_by` | `integer` | NULL | 最后修改者（与各表审计字段统一） |
| `updated_at` | `timestamptz` | NOT NULL | |

不删除（"已取消"为终态）；登记/取消/开始/完成使用状态+版本条件更新。
- 部分唯一索引：`(asset_id) WHERE status IN ('PENDING','REPAIRING')`——同一资产最多一张进行中维修单

### A-7 `repair_order_actions` 维修状态流转（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `order_id` | `integer` | NOT NULL → `repair_orders.id` ON DELETE CASCADE | |
| `action` | `enum repair_action` | NOT NULL | `REGISTER / CANCEL / START / COMPLETE` |
| `from_status` | `enum repair_status` | NOT NULL | |
| `to_status` | `enum repair_status` | NOT NULL | |
| `operator_id` | `integer` | NOT NULL | |
| `operator_name` | `text` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

## 3. 消耗品

### A-8 `consumables` 品种（物理删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `name` | `text` | NOT NULL，UNIQUE | 品种名称（硬删除后同名可再建） |
| `category_id` | `integer` | NULL | 分类（无外键） |
| `category_name` | `text` | NULL | 分类名称快照 |
| `unit_id` | `integer` | NULL | 单位（无外键） |
| `unit_name` | `text` | NOT NULL | 单位名称快照（已有业务事实后不可纠正） |
| `type` | `enum consumable_type` | NOT NULL | `DISPOSABLE / REUSABLE`（创建后不可变） |
| `quota_cycle` | `enum quota_cycle` | NULL | 一次性用品申领上限周期：`MONTH / QUARTER / YEAR` |
| `quota_limit` | `integer` | NULL | 周期内数量上限 |
| `return_days` | `integer` | NULL | 借还用品归还期限（天） |
| `max_holding` | `integer` | NULL | 借还用品同时持有上限 |
| `reference_price` | `numeric(18,2)` | NULL | 参考单价 |
| `safety_stock` | `integer` | NOT NULL `DEFAULT 0` | 安全库存 |
| `image_oss_key` | `text` | NULL | 图片对象标识 |
| `remark` | `text` | NULL | 备注 |
| `status` | `enum dict_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED` |
| `created_by` / `created_at` | | 基线 §2.1（无 `deleted_*`） | |
| `updated_by` / `updated_at` | | 基线 §2.1（无 `deleted_*`） | |

- CHECK：`type <> 'DISPOSABLE' OR (quota_cycle IS NOT NULL AND quota_limit IS NOT NULL)`；`type <> 'REUSABLE' OR (return_days IS NOT NULL AND max_holding IS NOT NULL)`
- 删除前必须无当前账面/占用库存、无未结清借还、无待审批引用（存在历史终态引用时可确认删除）

### A-9 `warehouses` 库位树（物理删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `parent_id` | `integer` | NULL → `warehouses.id` ON DELETE RESTRICT | 父库位；NULL=根 |
| `name` | `text` | NOT NULL | 库位名称 |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序 |
| `status` | `enum dict_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED` |
| `created_by` / `created_at` | | 基线 §2.1（无 `deleted_*`） | |
| `updated_by` / `updated_at` | | 基线 §2.1（无 `deleted_*`） | |

- 存在未删除子库位时禁止删除（FK RESTRICT）；改名/移动只影响当前树，历史快照不追溯改写

### A-10 `inventory_items` 库存条目

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `consumable_id` | `integer` | NOT NULL → `consumables.id` | 品种（删除品种前须清空条目） |
| `spec` | `text` | NOT NULL | 规格（快照文字） |
| `warehouse_id` | `integer` | NULL | 库位（无外键：库位删除后保留快照） |
| `warehouse_name` | `text` | NOT NULL | 库位名称快照 |
| `warehouse_path` | `text` | NOT NULL | 库位路径快照 |
| `book_qty` | `integer` | NOT NULL `DEFAULT 0` | 账面库存 |
| `reserved_qty` | `integer` | NOT NULL `DEFAULT 0` | 占用库存（待审批预留） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |
| `updated_at` | `timestamptz` | NOT NULL | 库存变动时间 |

可用库存 = `book_qty - reserved_qty`（计算，不冗余存储）。
- CHECK：`book_qty >= 0 AND reserved_qty >= 0 AND reserved_qty <= book_qty`
- 唯一索引：`(consumable_id, spec, COALESCE(warehouse_id, 0))`——同品种"规格+库位"合并为一个条目
- 账面与占用清零的空条目由应用层清理

### A-11 `batches` 批次

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `inventory_item_id` | `integer` | NOT NULL | 所属库存条目（无外键：条目清空后历史保留） |
| `source_batch_id` | `integer` | NULL | 调拨子批次的来源批次 |
| `consumable_id` | `integer` | NOT NULL | 品种（无外键：品种硬删除后历史保留） |
| `consumable_name` | `text` | NOT NULL | 品种名称快照 |
| `spec` | `text` | NOT NULL | 规格快照 |
| `warehouse_name` | `text` | NOT NULL | 库位名称快照 |
| `warehouse_path` | `text` | NOT NULL | 库位路径快照 |
| `supplier_id` | `integer` | NULL | 供应商（可纠正字段，无外键） |
| `supplier_name` | `text` | NULL | 供应商名称快照 |
| `brand_id` | `integer` | NULL | 品牌（可纠正字段，无外键） |
| `brand_name` | `text` | NULL | 品牌名称快照 |
| `unit_price` | `numeric(18,2)` | NULL | 单价（可纠正） |
| `remark` | `text` | NULL | 批次备注（可纠正） |
| `received_at` | `timestamptz` | NOT NULL | 入库时间（=入库申请整单申请时间） |
| `remaining_qty` | `integer` | NOT NULL `DEFAULT 0` | 剩余数量（FIFO 出库扣减） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |
| `updated_by` | `integer` | NULL | 纠正操作者 |
| `updated_at` | `timestamptz` | NOT NULL | 纠正时间 |

- CHECK：`remaining_qty >= 0`
- 纠正（供应商/品牌/单价/备注）记录前后值（A-12）；规格/库位纠正仅在无后续流水且无待审批占用时允许
- 查询索引：`(inventory_item_id)`、`(source_batch_id)`

### A-12 `batch_corrections` 批次纠正记录（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `batch_id` | `integer` | NOT NULL → `batches.id` | |
| `before` | `jsonb` | NOT NULL | 纠正前字段值 |
| `after` | `jsonb` | NOT NULL | 纠正后字段值 |
| `reason` | `text` | NOT NULL | 纠正原因 |
| `operator_id` | `integer` | NOT NULL | |
| `operator_name` | `text` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

## 4. 库存流水与调拨

### A-13 `stock_flows` 库存流水（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `flow_type` | `enum stock_flow_type` | NOT NULL | `STOCK_IN / ISSUE / DEDUCTION / RETURN / TRANSFER_OUT / TRANSFER_IN / CORRECTION` |
| `direction` | `enum flow_direction` | NOT NULL | `IN / OUT` |
| `inventory_item_id` | `integer` | NOT NULL | 条目（无外键） |
| `batch_id` | `integer` | NULL | 批次（无外键） |
| `consumable_name` | `text` | NOT NULL | 品种名称快照 |
| `spec` | `text` | NOT NULL | 规格快照 |
| `warehouse_name` | `text` | NOT NULL | 库位名称快照 |
| `warehouse_path` | `text` | NOT NULL | 库位路径快照 |
| `qty` | `integer` | NOT NULL | 变动数量（正整数） |
| `book_before` | `integer` | NOT NULL | 变动前账面 |
| `book_after` | `integer` | NOT NULL | 变动后账面 |
| `ref_type` | `text` | NULL | 业务来源类型（申请/调拨/处置等） |
| `ref_id` | `integer` | NULL | 业务来源标识 |
| `operator_id` | `integer` | NOT NULL | |
| `operator_name` | `text` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 发生时间 |

- CHECK：`qty > 0`、`book_before >= 0`、`book_after >= 0`
- 查询索引：`(inventory_item_id, created_at)`、`(batch_id)`、`(ref_type, ref_id)`

### A-14 `inventory_transfers` 调拨主记录（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `from_inventory_item_id` | `integer` | NOT NULL | 来源条目（无外键） |
| `to_inventory_item_id` | `integer` | NOT NULL | 目标条目（无外键） |
| `from_warehouse_name` | `text` | NOT NULL | 来源库位快照 |
| `from_warehouse_path` | `text` | NOT NULL | 来源库位路径快照 |
| `to_warehouse_name` | `text` | NOT NULL | 目标库位快照 |
| `to_warehouse_path` | `text` | NOT NULL | 目标库位路径快照 |
| `qty` | `integer` | NOT NULL | 调拨数量 |
| `remark` | `text` | NULL | 备注 |
| `operator_id` | `integer` | NOT NULL | |
| `operator_name` | `text` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

不可编辑、不可删除；纠正误调拨=反向调拨。
- CHECK：`qty > 0`

### A-15 `transfer_batch_items` 调拨批次分配明细（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `transfer_id` | `integer` | NOT NULL → `inventory_transfers.id` ON DELETE CASCADE | |
| `source_batch_id` | `integer` | NOT NULL | 来源批次 |
| `target_batch_id` | `integer` | NOT NULL | 目标库位创建的调拨子批次 |
| `qty` | `integer` | NOT NULL | 该段移动数量 |

- CHECK：`qty > 0`；全部来源减少量之和 = 全部目标增加量（应用层事务保证）

## 5. 审批（asset）

### A-16 `approval_requests` 审批头（asset）

结构遵循 backstage.md §S-16 通用审批契约；asset 独立服务，用户引用不建外键（存 ID + 姓名/部门快照）。

- `request_type`：`STOCK_IN / STOCK_CHANGE / CONSUMABLE_REQUEST / AGENT_REQUEST / RETURN / WRITE_OFF / AGENT_SETTLEMENT`
- 待审批数量限制（本模块）：部分唯一索引 `(ref_request_id) WHERE request_type = 'AGENT_SETTLEMENT' AND status = 'PENDING'`——同一代领清单最多一条待审批结清申请
- 入库/库存变更/申领/归还/核销允许多张待审批（库存占用与额度约束在应用层事务保证）

### A-17 `approval_actions` 审批处理记录

结构遵循 backstage.md §S-17，本模块同构。

### A-18 `stock_in_items` 入库申请明细

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` ON DELETE CASCADE | |
| `consumable_id` | `integer` | NOT NULL | 品种（无外键） |
| `consumable_name` | `text` | NOT NULL | 品种名称快照 |
| `supplier_id` | `integer` | NULL | 供应商（无外键） |
| `supplier_name` | `text` | NULL | 供应商名称快照 |
| `brand_id` | `integer` | NULL | 品牌（无外键） |
| `brand_name` | `text` | NULL | 品牌名称快照 |
| `spec` | `text` | NOT NULL | 规格 |
| `warehouse_id` | `integer` | NOT NULL | 目标库位（无外键） |
| `warehouse_name` | `text` | NOT NULL | 库位名称快照 |
| `warehouse_path` | `text` | NOT NULL | 库位路径快照 |
| `qty` | `integer` | NOT NULL | 数量 |
| `unit_price` | `numeric(18,2)` | NULL | 单价（可空） |
| `received_at` | `timestamptz` | NOT NULL | 批次入库时间（=整单申请时间） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- CHECK：`qty > 0`；唯一索引：`(request_id, consumable_id, spec, warehouse_id)`
- 批准后按行形成批次（A-11）并生成入库流水

### A-19 `stock_change_items` 库存变更申请明细

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` ON DELETE CASCADE | |
| `inventory_item_id` | `integer` | NOT NULL | 库存条目（无外键） |
| `consumable_name` | `text` | NOT NULL | 品种名称快照 |
| `spec` | `text` | NOT NULL | 规格快照 |
| `warehouse_name` | `text` | NOT NULL | 库位名称快照 |
| `warehouse_path` | `text` | NOT NULL | 库位路径快照 |
| `change_type_id` | `integer` | NULL | 变更类型（字典，无外键） |
| `change_type_name` | `text` | NULL | 变更类型名称快照 |
| `reason` | `text` | NOT NULL | 具体原因（必填） |
| `qty` | `integer` | NOT NULL | 扣减数量 |
| `changed_at` | `timestamptz` | NOT NULL | 变更时间（=整单申请时间） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- CHECK：`qty > 0`；唯一索引：`(request_id, inventory_item_id)`——同一条目整单一次

### A-20 `consumable_request_items` 申领清单明细（普通 + 代交共享清单）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` ON DELETE CASCADE | |
| `inventory_item_id` | `integer` | NOT NULL | 库存条目（无外键） |
| `consumable_name` | `text` | NOT NULL | 品种名称快照 |
| `spec` | `text` | NOT NULL | 规格快照 |
| `warehouse_name` | `text` | NOT NULL | 库位名称快照 |
| `warehouse_path` | `text` | NOT NULL | 库位路径快照 |
| `qty` | `integer` | NOT NULL | 数量（代交清单=共享清单总数量，不按受领人分摊） |
| `purpose` | `text` | NULL | 用途（普通申领必填；代交共享清单可空） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- CHECK：`qty > 0`；唯一索引：`(request_id, inventory_item_id)`——同一条目整单一次

### A-21 `agent_recipients` 代领受领人名单

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` ON DELETE CASCADE | |
| `user_id` | `integer` | NOT NULL | 受领人（不能选择发起人自己） |
| `user_name` | `text` | NOT NULL | 受领人姓名快照 |
| `department_snapshot` | `jsonb` | NOT NULL | 提交时部门快照 `[{id, name}]`（审批范围校验） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- 唯一索引：`(request_id, user_id)`
- 库存占用与出库只按共享清单总数量一次计算，不按受领人数乘算

### A-22 `quota_occupations` 申领额度占用

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `user_id` | `integer` | NOT NULL | 员工 |
| `consumable_id` | `integer` | NOT NULL | 品种（无外键） |
| `consumable_name` | `text` | NOT NULL | 品种名称快照 |
| `quota_type` | `enum quota_type` | NOT NULL | `DISPOSABLE_CYCLE / REUSABLE_HOLDING` |
| `cycle` | `enum quota_cycle` | NULL | 周期（一次性用品） |
| `cycle_key` | `text` | NULL | 周期标识（如 `2026-08` / `2026-Q3` / `2026`，提交时间归属） |
| `request_id` | `integer` | NOT NULL | 关联申请（无外键） |
| `qty` | `integer` | NOT NULL | 占用数量 |
| `status` | `enum quota_status` | NOT NULL `DEFAULT RESERVED` | `RESERVED / CONSUMED / RELEASED` |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 提交时占用时间 |

- CHECK：`qty > 0`
- 批准：`RESERVED → CONSUMED`；驳回/取消：`RESERVED → RELEASED`（与应用终态同一事务）
- 代交申领不产生额度占用
- 查询索引：`(user_id, consumable_id, cycle_key)`——额度校验按固定顺序锁定（应用层）

### A-23 `borrow_records` 借还记录（个人 + 清单级代领）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `record_type` | `enum borrow_type` | NOT NULL | `PERSONAL / AGENT` |
| `user_id` | `integer` | NULL | 借用人（PERSONAL；AGENT 无个人借用人） |
| `user_name` | `text` | NULL | 借用人姓名快照 |
| `department_snapshot` | `jsonb` | NULL | 借出时部门快照（PERSONAL；直接处置范围校验） |
| `agent_request_id` | `integer` | NULL | 代领清单申请 ID（AGENT） |
| `request_id` | `integer` | NOT NULL | 来源申领申请 ID |
| `inventory_item_id` | `integer` | NOT NULL | 条目（无外键） |
| `consumable_name` | `text` | NOT NULL | 品种名称快照 |
| `spec` | `text` | NOT NULL | 规格快照 |
| `warehouse_name` | `text` | NOT NULL | 库位名称快照 |
| `warehouse_path` | `text` | NOT NULL | 库位路径快照 |
| `qty` | `integer` | NOT NULL | 借出数量 |
| `borrowed_at` | `timestamptz` | NOT NULL | 出库时间 |
| `due_at` | `timestamptz` | NOT NULL | 到期时间（=出库时间 + 品种归还期限快照） |
| `returned_qty` | `integer` | NOT NULL `DEFAULT 0` | 已归还 |
| `written_off_qty` | `integer` | NOT NULL `DEFAULT 0` | 已核销 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

未结清 = `qty - returned_qty - written_off_qty`；逾期只提示不阻止。
- CHECK：`qty > 0`、`returned_qty + written_off_qty <= qty`
- 查询索引：`(user_id)`、`(agent_request_id)`、`(created_at)`

### A-24 `borrow_action_items` 归还/核销申请明细

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` ON DELETE CASCADE | |
| `borrow_record_id` | `integer` | NOT NULL → `borrow_records.id` | |
| `qty` | `integer` | NOT NULL | 本次处理数量 |
| `write_off_type` | `enum write_off_type` | NULL | 核销类型：`LOST / DAMAGED`（WRITE_OFF 必填） |
| `reason` | `text` | NULL | 核销原因（必填）/归还备注（可选） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- CHECK：`qty > 0`；唯一索引：`(request_id, borrow_record_id)`
- 可申请处理数量 = 未结清 − 待审批归还占用 − 待审批核销占用（应用层事务锁定）

### A-25 `agent_settlement_items` 代领结清申请明细

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` ON DELETE CASCADE | |
| `borrow_record_id` | `integer` | NOT NULL → `borrow_records.id` | 清单级代领借还记录 |
| `qty` | `integer` | NOT NULL | 该处理方式数量 |
| `method` | `enum settle_method` | NOT NULL | `RETURN / WRITE_OFF` |
| `write_off_type` | `enum write_off_type` | NULL | 遗失/损坏（method=WRITE_OFF 必填） |
| `reason` | `text` | NULL | 核销原因/归还备注 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- CHECK：`qty > 0`；唯一索引：`(request_id, borrow_record_id, method)`
- 每种物品各处理方式数量之和 = 该物品全部未结清数量（应用层整单校验）

### A-26 `direct_disposal_records` 注销员工借还直接处置记录（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `disposal_type` | `enum disposal_type` | NOT NULL | `RETURN / WRITE_OFF / AGENT_SETTLE` |
| `borrow_record_id` | `integer` | NULL | 个人借还记录（RETURN/WRITE_OFF） |
| `agent_request_id` | `integer` | NULL | 代领清单（AGENT_SETTLE） |
| `user_id` | `integer` | NULL | 借用人快照 |
| `user_name` | `text` | NULL | 借用人姓名快照 |
| `department_snapshot` | `jsonb` | NULL | 借出时部门快照 |
| `inventory_item_id` | `integer` | NOT NULL | 条目（无外键） |
| `consumable_name` | `text` | NOT NULL | 品种名称快照 |
| `spec` | `text` | NOT NULL | 规格快照 |
| `warehouse_name` | `text` | NOT NULL | 库位名称快照 |
| `warehouse_path` | `text` | NOT NULL | 库位路径快照 |
| `qty` | `integer` | NOT NULL | 处理数量 |
| `write_off_type` | `enum write_off_type` | NULL | 核销类型 |
| `reason` | `text` | NULL | 核销原因/归还备注 |
| `processor_id` | `integer` | NOT NULL | 处理人（审批人） |
| `processor_name` | `text` | NOT NULL | 处理人姓名快照 |
| `stock_flow_refs` | `jsonb` | NULL | 关联库存流水引用 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 处理时间 |

不可编辑、不可删除；不创建审批申请、不进入待审批。

## 6. 二维码

### A-27 `qr_codes` 二维码

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `public_id` | `text` | NOT NULL，UNIQUE | 公开不透明标识（≥128 位随机性，不编码内部 ID） |
| `target_type` | `enum qr_target_type` | NOT NULL | `ASSET / INVENTORY_ITEM / SCAN_CATALOG` |
| `target_id` | `integer` | NULL | 目标标识（SCAN_CATALOG 为 NULL） |
| `status` | `enum qr_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED / REVOKED`（REVOKED 终态不可恢复） |
| `revoked_at` | `timestamptz` | NULL | 作废时间 |
| `created_by` | `integer` | NOT NULL | 生成人 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |
| `updated_by` | `integer` | NULL | 状态变更操作者 |
| `updated_at` | `timestamptz` | NOT NULL | |

- 部分唯一索引：`(target_type, COALESCE(target_id, 0)) WHERE status <> 'REVOKED'`——目标同时最多一张有效/停用二维码（"作废并重新生成"创建新行）

## 7. 配置

### A-28 `asset_settings` 资产配置

结构与 backstage.md §S-8 一致（`key` UNIQUE、`value`、`value_type`、`label`、`updated_by`、`updated_at`），无 `group`/`sensitive`（MVP 资产参数无敏感项）。运行参数：扫码入口地址、申领上限重置日（1～28，默认 1 号）。

### A-29 `operation_logs`（asset schema）

结构与 `base.operation_logs`（B-4）完全一致，只写本模块日志。

### A-30 `user_table_prefs` 用户表格偏好（物理删除）

结构与 `base.user_table_prefs`（B-5）完全一致（`user_id` 不建外键），只存 asset 页面偏好（筛选预设 + 列设置，主 PRD §10.2）。

### A-31 `borrow_batch_allocations` 借还批次分配明细

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `borrow_record_id` | `integer` | NOT NULL → `borrow_records.id`（级联删除） | 借还记录 1—N 分配明细 |
| `batch_id` | `integer` | NOT NULL → `batches.id`（RESTRICT） | 借出来源批次（归还必须回到原批次） |
| `issued_qty` | `integer` | NOT NULL | 该批次借出数量 |
| `returned_qty` | `integer` | NOT NULL `DEFAULT 0` | 已归还数量 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- 唯一约束：`(borrow_record_id, batch_id)`（一次借出同一批次只分配一行）
- CHECK：`issued_qty > 0`、`returned_qty >= 0 AND returned_qty <= issued_qty`
- **恢复规则**：归还按"最后借出先归还"（分配行倒序）逐段恢复对应批次的 `remaining_qty` 与条目账面（`book_qty` 递增），保证归还只回到尚未归还份额的原始批次；新增记录在申领批准出库时按 FIFO 出库分配写入，历史记录由迁移按 ISSUE 流水回填
- 查询索引：`(batch_id)`

**表间关系**：`asset_categories` 自引用（顶级/子分类）；`assets` 1—N `asset_transfers`/`asset_changes`/`repair_orders`；`repair_orders` 1—N `repair_order_actions`；`consumables` 1—N `inventory_items` 1—N `batches`；`inventory_transfers` 1—N `transfer_batch_items`；`approval_requests` 1—N `approval_actions` 及各业务明细表；`consumable_request_items` 1—N 关系仅受领人名单（A-21）并列挂接同一申请；`quota_occupations`/`borrow_records` 独立引用申请；`borrow_records` 1—N `borrow_batch_allocations`（A-31，归还回库的核心配套表）。
