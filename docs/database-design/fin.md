# WBME 数据库表设计：fin 模块

> schema：`fin`，独立部署单元。
> 表结构遵循 `00-baseline.md` 公共基线；金额一律 `numeric(18,2)`（Prisma `Decimal`），API 边界十进制字符串传输（主 PRD §9.11）。
> 财务数据为全公司范围，无部门/本人维度。

## F-1 `projects` 项目主档（软删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `name` | `text` | NOT NULL | 项目名称（保留原文展示） |
| `year` | `integer` | NOT NULL | 年度（四位公历年） |
| `business_key` | `text` | NOT NULL | 规范化业务键（NFC/空白归一化/大小写折叠，与年度共同唯一） |
| `completeness_docs` | `jsonb` | NULL | 资料齐全度多选 `[{id, name}]`（按选择顺序） |
| `region_id` | `integer` | NULL | 地区（无外键：字典停用/删除后历史保留） |
| `region_name` | `text` | NULL | 地区名称快照 |
| `progress_id` | `integer` | NULL | 项目进度（无外键） |
| `progress_name` | `text` | NULL | 项目进度名称快照 |
| `progress_semantic` | `enum amount_semantic` | NULL | 金额语义快照 `TENTATIVE / AUDITED`（未选进度按 TENTATIVE 处理） |
| `biz_category_id` | `integer` | NULL | 业务分类（无外键，可空） |
| `biz_category_name` | `text` | NULL | 业务分类名称快照 |
| `party_a` | `text` | NULL | 甲方 |
| `general_contractor` | `text` | NULL | 总包方 |
| `management_fee` | `text` | NULL | 管理费（可能不为数字） |
| `subcontractors` | `text[]` | NOT NULL，默认空数组 | 分包方（手输数组，可多项；Prisma 不支持可空标量数组，空数组语义等价于可空） |
| `contract_start_date` | `date` | NULL | 合同开始日期 |
| `contract_end_date` | `date` | NULL | 合同完工日期 |
| `contract_amount` | `numeric(18,2)` | NULL | 合同金额 |
| `payment_node` | `text` | NULL | 主合同付款节点 |
| `tentative_audited_amount` | `numeric(18,2)` | NULL | 暂定/审定金额（语义随进度切换） |
| `settlement` | `numeric(18,2)` | NULL | 分包结算 |
| `misc_expense` | `numeric(18,2)` | NULL | 零星费用 |
| `remark` | `text` | NULL | 项目级备注 |
| `data_revision` | `integer` | NOT NULL `DEFAULT 0` | 数据修订号：每次成功变更递增（即时保存排序 / Excel 覆盖前置条件） |
| `created_by` / `created_at` | | 基线 §2.1 | |
| `updated_by` / `updated_at` | | 基线 §2.1 | |
| `deleted_by` / `deleted_at` | | 基线 §2.1 | |

- 唯一索引：`(business_key, year)`——**含软删除行**（软删除记录仍占用业务唯一键，恢复/改名后方可重建）
- CHECK：`year BETWEEN 1000 AND 9999`（四位公历年）；全部手工金额字段 `>= 0`（允许 0）；自动计算字段（累计开票/收款/分包付款、剩余未开票/未收款、暂定保通权益、毛利率）不落库，由后端基于最新数据实时计算
- 毛利率等比率内部以十进制高精度表达，API 十进制字符串传输

## F-2 `invoices` 开票金额明细

## F-3 `receipts` 已收回款明细

## F-4 `subcontract_payments` 已付分包款明细

> F-2 / F-3 / F-4 三张表结构完全一致，仅业务语义不同；明细允许单条物理删除（主 PRD §2.6 例外，删除前在同一事务写入删除前完整快照审计）。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `project_id` | `integer` | NOT NULL → `projects.id` | |
| `amount` | `numeric(18,2)` | NOT NULL | 金额（非负） |
| `occurred_date` | `date` | NULL | 日期 |
| `remark` | `text` | NULL | 单笔备注 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |
| `updated_at` | `timestamptz` | NOT NULL | 修改时间 |

- CHECK：`amount >= 0`；查询索引：`(project_id)`——按明细顺序（id 升序）展示与导出
- 明细增删改的审计由 F-5 项目操作记录承载

## F-5 `project_operations` 项目操作记录（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `project_id` | `integer` | NOT NULL → `projects.id` | |
| `operator_id` | `integer` | NOT NULL | 操作者 |
| `operator_name` | `text` | NOT NULL | 操作者姓名快照 |
| `action` | `enum project_action` | NOT NULL | `CREATE / EDIT / DELETE / IMPORT_CREATE / IMPORT_OVERWRITE / IMPORT_SKIP` |
| `field` | `text` | NULL | 变更字段（单字段即时保存时） |
| `before` | `jsonb` | NULL | 变更前值/删除前完整快照 |
| `after` | `jsonb` | NULL | 变更后值/导入后快照 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 操作时间 |

- 提交前后无实际差异时不产生记录；与业务变更同一数据库事务
- 查询索引：`(project_id, created_at)`、`(created_at)`——列表按时间倒序

## F-6 `finance_dict_items` 财务字典（物理删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `dict_type` | `enum finance_dict_type` | NOT NULL | `PROGRESS / COMPLETENESS / BIZ_CATEGORY / REGION`（地区跨系统统一在此维护） |
| `name` | `text` | NOT NULL | 字典项名称 |
| `semantic` | `enum amount_semantic` | NULL | 金额语义 `TENTATIVE / AUDITED`（仅 PROGRESS，创建时必选，被引用后不可修改） |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序 |
| `status` | `enum dict_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED` |
| `created_by` / `created_at` | | 基线 §2.1（无 `deleted_*`） | |
| `updated_by` / `updated_at` | | 基线 §2.1（无 `deleted_*`） | |

- CHECK：`dict_type <> 'PROGRESS' OR semantic IS NOT NULL`
- 唯一索引：`(dict_type, name)`；业务分类真实项不得与系统虚拟分组"未分类"重名（应用层校验）
- 被历史项目引用的项不可删除（整批拒绝）；停用项原引用往返按导入规则处理

## F-7 `finance_settings` 财务配置

结构与 backstage.md §S-8 一致（`key` UNIQUE、`value`、`value_type`、`label`、`updated_by`、`updated_at`），无 `group`/`sensitive`（MVP 财务参数无敏感项）；MVP 无固定运行参数，机制保留。

## F-8 `operation_logs`（fin schema）

结构与 `base.operation_logs`（B-4）完全一致，只写本模块日志。

## F-9 `user_table_prefs` 用户表格偏好（物理删除）

结构与 `base.user_table_prefs`（B-5）完全一致（`user_id` 不建外键），只存 fin 页面偏好（筛选预设 + 列设置，主 PRD §10.2）。

**表间关系**：`projects` 1—N `invoices`/`receipts`/`subcontract_payments`/`project_operations`；`finance_dict_items` 独立（被项目以 ID+名称快照引用）。

## 本期无表模块

- `ai`（智能模块）与 `agent`（智能对话）本期不实现，不建表。
