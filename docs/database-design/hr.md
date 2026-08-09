# WBME 数据库表设计：hr 模块

> schema：`hr`，独立部署单元。
> 表结构遵循 `00-baseline.md` 公共基线；跨模块引用（用户等）不建外键，只存 ID + 快照字段。
> 组织版本：`org_meta` 维护全局 `user_org_version`（用户组织关系事务递增）与 `org_tree_version`（部门树变更事务递增），供守卫缓存校验。

## H-1 `org_meta` 组织版本（单行）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，`CHECK (id = 1)` | 恒为单行 |
| `user_org_version` | `integer` | NOT NULL `DEFAULT 0` | 用户组织版本 |
| `org_tree_version` | `integer` | NOT NULL `DEFAULT 0` | 组织树版本 |
| `updated_at` | `timestamptz` | NOT NULL | |

## H-2 `departments` 部门（物理删除，树形）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `parent_id` | `integer` | NULL → `departments.id` ON DELETE RESTRICT | 父部门；NULL=根 |
| `name` | `text` | NOT NULL | 部门名称 |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序 |
| `status` | `enum dept_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED` |
| `created_by` / `created_at` | | 基线 §2.1（无 `deleted_*`） | |
| `updated_by` / `updated_at` | | 基线 §2.1（无 `deleted_*`） | |

配置类数据：批量硬删除，有未删除下级部门时禁止删除；父子关系/停用/删除事务递增 `org_tree_version`；删除事务内清理：员工关系（H-5）、部门负责人（H-3）、岗位适用范围（H-6）、资产/职称等业务引用置空（跨服务由调用方处理）。
- 查询索引：`(parent_id)`

## H-3 `department_leaders` 部门负责人

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `department_id` | `integer` | NOT NULL → `departments.id` ON DELETE CASCADE | |
| `user_id` | `integer` | NOT NULL | 负责人（不建外键） |
| `user_name` | `text` | NOT NULL | 负责人姓名快照 |
| `created_by` | `integer` | NOT NULL | 维护者 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

一个部门可多名负责人；移除负责人=物理删除行。
- 唯一索引：`(department_id, user_id)`

## H-4 `positions` 岗位（物理删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `name` | `text` | NOT NULL | 岗位名称 |
| `description` | `text` | NULL | |
| `status` | `enum position_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED` |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序 |
| `allow_self_apply` | `boolean` | NOT NULL `DEFAULT false` | 是否允许员工自助申请 |
| `created_by` / `created_at` | | 基线 §2.1（无 `deleted_*`） | |
| `updated_by` / `updated_at` | | 基线 §2.1（无 `deleted_*`） | |

配置类数据：批量硬删除；删除事务内把员工当前岗位置空（H-7 `ON DELETE SET NULL`），待审批岗位申请此后无法批准。
- 唯一索引：`(name)`

## H-5 `position_departments` 岗位适用部门

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `position_id` | `integer` | NOT NULL → `positions.id` ON DELETE CASCADE | |
| `department_id` | `integer` | NOT NULL → `departments.id` ON DELETE CASCADE | 适用部门 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- 唯一索引：`(position_id, department_id)`
- 修改适用部门前校验全部在岗员工兼容性（应用层）

## H-6 `title_rules` 职称规则（软删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `title_name` | `text` | NOT NULL | 职称名称 |
| `department_id` | `integer` | NULL | 部门条件（无外键：部门删除后条件永不命中） |
| `position_id` | `integer` | NULL | 岗位条件（无外键：岗位删除后条件永不命中） |
| `role_condition` | `enum site_role` | NULL | 站点角色条件：`SUPER_ADMIN / EMPLOYEE` |
| `status` | `enum rule_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED` |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序 |
| `created_by` / `created_at` | | 基线 §2.1 | |
| `updated_by` / `updated_at` | | 基线 §2.1 | |
| `deleted_by` / `deleted_at` | | 基线 §2.1 | |

匹配规则：全部非空条件同时成立（部门条件对多部门员工任一命中即匹配）；唯一职称按"非空条件数量多 → 排序小 → ID 小"确定，由应用层计算。

## H-7 `user_departments` 用户部门关系

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `user_id` | `integer` | NOT NULL | 员工（不建外键；注销期间关系保留） |
| `department_id` | `integer` | NOT NULL → `departments.id` ON DELETE CASCADE | 所属部门 |
| `created_by` | `integer` | NOT NULL | 编排操作者（组织管理员） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

多部门并列、无主次；新增/调整/移除只由组织管理员编排；移除=物理删除行；变更事务递增 `user_org_version`。
- 唯一索引：`(user_id, department_id)`
- 查询索引：`(department_id)`

## H-8 `user_positions` 用户岗位（单行）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `user_id` | `integer` | PK | 员工（一对一：单岗位） |
| `position_id` | `integer` | NULL → `positions.id` ON DELETE SET NULL | 当前岗位（可空） |
| `assigned_by` | `integer` | NOT NULL | 编排操作者 |
| `assigned_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |
| `updated_at` | `timestamptz` | NOT NULL | |

变更事务递增 `user_org_version`。
> T6 实现登记：恢复兼容性清理岗位置空（`position_id=null`）时保留原 `assigned_by` 值
> （系统清理不改写编排者审计；`assigned_by` NOT NULL 约束下置空仅改岗位字段）。

## H-9 `org_compat_records` 恢复兼容性处理记录（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `user_id` | `integer` | NOT NULL | 被恢复员工 |
| `restore_request_id` | `text` | NOT NULL | 恢复请求标识（跨服务幂等键） |
| `cleared_departments` | `jsonb` | NULL | 被清除的部门快照 `[{id, name}]` |
| `position_cleared` | `boolean` | NOT NULL `DEFAULT false` | 岗位是否被置空 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

## H-10 `approval_requests` 审批头（hr）

结构遵循 backstage.md §S-16 通用审批契约；hr 独立服务，用户引用不建外键（存 ID + 姓名/部门快照）。

- `request_type`：`OVERTIME / POSITION_CHANGE`
- 待审批数量限制（本模块）：部分唯一索引 `(applicant_id) WHERE request_type = 'POSITION_CHANGE' AND status = 'PENDING'`——同一员工同时最多一条待审批岗位申请；加班允许多条（时间段不重叠校验在应用层）
- `ref_request_id` 本期不使用

## H-11 `approval_actions` 审批处理记录

结构遵循 backstage.md §S-17，本模块同构。

## H-12 `overtime_items` 加班明细

> 加班批次：一张申请多个加班员工，共用同一日期、时间段与事由；业务字段随明细行保存（提交时逐明细快照）。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` ON DELETE CASCADE | |
| `user_id` | `integer` | NOT NULL | 加班员工 |
| `user_name` | `text` | NOT NULL | 姓名快照 |
| `department_snapshot` | `jsonb` | NOT NULL | 提交时部门快照 `[{id, name}]` |
| `overtime_date` | `date` | NOT NULL | 加班日期（自然日） |
| `start_minute` | `integer` | NOT NULL | 开始分钟（0-1439） |
| `end_minute` | `integer` | NOT NULL | 结束分钟（1-1440，`24:00`=1440） |
| `reason` | `text` | NOT NULL | 事由 |
| `holiday_snapshot` | `jsonb` | NOT NULL | 节假日判断快照：`{date_type, source, digest, fetched_at}` |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- CHECK：`start_minute >= 0`、`start_minute < end_minute`、`end_minute <= 1440`
- 唯一索引：`(request_id, user_id)`——同一批次不重复
- 查询索引：`(user_id, overtime_date)`——个人记录/月度汇总；时间段重叠校验在应用层

## H-13 `position_change_requests` 岗位申请明细

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` ON DELETE CASCADE | |
| `user_id` | `integer` | NOT NULL | 申请员工（=申请人，1:1） |
| `user_name` | `text` | NOT NULL | 姓名快照 |
| `department_snapshot` | `jsonb` | NOT NULL | 提交时部门快照 |
| `target_department_id` | `integer` | NOT NULL | 目标部门（无外键：部门删除后不可批准） |
| `target_department_name` | `text` | NOT NULL | 目标部门名称快照 |
| `target_position_id` | `integer` | NOT NULL | 目标岗位（无外键：岗位删除后不可批准） |
| `target_position_name` | `text` | NOT NULL | 目标岗位名称快照 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

一张申请固定一个目标部门 + 一个目标岗位。

## H-14 `holiday_results` 节假日 API 结果

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `holiday_date` | `date` | PK | 日期 |
| `date_type` | `enum holiday_date_type` | NOT NULL | `WORKDAY / WEEKEND / HOLIDAY / ADJUSTED_HOLIDAY / ADJUSTED_WORKDAY` |
| `weekday` | `integer` | NOT NULL | 星期值（1-7） |
| `provider_id` | `text` | NOT NULL | 供应商标识 |
| `raw_digest` | `text` | NOT NULL | 原始响应 SHA-256 摘要 |
| `normalized` | `jsonb` | NOT NULL | 规范化结果 |
| `fetched_at` | `timestamptz` | NOT NULL | 获取时间 |

按日期 UPSERT；24 小时缓存复用由应用层控制；离线兜底命中不落库（随版本内置）。

## H-15 `hr_settings` 人事设置

结构与 backstage.md §S-8 一致（`key` UNIQUE、`value`、`value_type`、`label`、`updated_by`、`updated_at`），无 `group`/`sensitive`（MVP 人事参数无敏感项）。运行参数：加班提前申请窗口（默认 30 天）、加班补交窗口（默认 7 天）等。

## H-16 `hr_dicts` 人事字典

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `dict_type` | `enum hr_dict_type` | NOT NULL | 字典类型（随业务引入；PostgreSQL/Prisma enum 不可为空集，MVP 实现时须先定义至少一个占位枚举值，业务引入时扩展） |
| `name` | `text` | NOT NULL | 字典项名称 |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序 |
| `status` | `enum dict_status` | NOT NULL `DEFAULT ACTIVE` | `ACTIVE / DISABLED` |
| `created_by` / `created_at` | | 基线 §2.1（无 `deleted_*`） | |
| `updated_by` / `updated_at` | | 基线 §2.1（无 `deleted_*`） | |

配置类：批量硬删除未被引用项；历史记录按名称快照展示原值。
- 唯一索引：`(dict_type, name)`

## H-17 `operation_logs`（hr schema）

结构与 `base.operation_logs`（B-4）完全一致，只写本模块日志。

## H-18 `user_table_prefs` 用户表格偏好（物理删除）

结构与 `base.user_table_prefs`（B-5）完全一致（`user_id` 不建外键），只存 hr 页面偏好（筛选预设 + 列设置，主 PRD §10.2）。

**表间关系**：`departments` 自引用树 + 1—N `department_leaders`/`user_departments`；`positions` 1—N `position_departments`、1—N `user_positions`（岗位可由多人任职）；`approval_requests` 1—N `approval_actions`、1—N `overtime_items`、1—1 `position_change_requests`；`org_meta` 单行。
