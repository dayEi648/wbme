# WBME 数据库表设计：backstage 模块

> schema：`backstage`，归属部署单元 `platform-core`（与 base 同一 Prisma Client、同一迁移序列）。
> 表结构遵循 `00-baseline.md` 公共基线。
> 集中错误日志、安全日志与统一后台任务表是主 PRD §9.4 明确的平台基础设施跨 schema 写入例外，由共享日志/任务模块以受限语句写入。
> **字段约束语义**：本文与 `base.md` 中 `→ xxx.id` 表示逻辑引用（同部署单元内可由 Prisma 关系建立物理外键；跨部署单元或仅作审计留存的字段为逻辑引用，不建物理外键），实际物理外键以 Prisma schema 与迁移 SQL 为准。

## 1. 功能权限目录（系统 → 业务板块 → 功能 三层）

### S-1 `systems` 系统

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `code` | `text` | NOT NULL，UNIQUE | 系统编码（`BASE` 不进入目录；`BACKSTAGE / ASSET / HR / FIN`） |
| `name` | `text` | NOT NULL | 系统名称 |
| `product_status` | `enum product_status` | NOT NULL `DEFAULT COMING_SOON` | `OPEN / COMING_SOON`（asset/hr/fin 可调；backstage 恒开放） |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 入口排序 |
| `updated_by` | `integer` | NULL | |
| `updated_at` | `timestamptz` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

无删除字段：系统由代码注册，只调整状态。

### S-2 `business_sections` 业务板块

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `system_id` | `integer` | NOT NULL → `systems.id` | 所属系统 |
| `code` | `text` | NOT NULL | 板块编码（开发定义） |
| `name` | `text` | NOT NULL | 板块名称 |
| `description` | `text` | NULL | 业务说明（管理员可维护） |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序（开发定义，界面不可调） |
| `updated_by` | `integer` | NULL | |
| `updated_at` | `timestamptz` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- 唯一索引：`(system_id, code)`

### S-3 `functions` 功能

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `system_id` | `integer` | NOT NULL → `systems.id` | 所属系统 |
| `section_id` | `integer` | NOT NULL → `business_sections.id` | 所属板块 |
| `code` | `text` | NOT NULL，UNIQUE | 稳定功能编码 |
| `name` | `text` | NOT NULL | 功能名称 |
| `data_scope_options` | `text[]` | NOT NULL `DEFAULT '{}'` | 可选数据范围档位（`SELF / DEPARTMENT / COMPANY` 子集） |
| `sort` | `integer` | NOT NULL `DEFAULT 0` | 排序（开发定义） |
| `description` | `text` | NULL | 业务说明文字（管理员可维护） |
| `updated_by` | `integer` | NULL | |
| `updated_at` | `timestamptz` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

无删除字段：启动对账时新增/移除功能（移除=物理删除行），目录变更在同一事务递增 `S-4` 目录版本。

### S-4 `permission_catalog_meta` 权限目录版本（单行）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，`CHECK (id = 1)` | 恒为单行 |
| `catalog_version` | `integer` | NOT NULL `DEFAULT 0` | 全局权限目录版本 |
| `updated_at` | `timestamptz` | NOT NULL | |

目录新增/移除/归属/可选范围变化时在同一事务递增。

## 2. 员工授权与权限组

### S-5 `employee_grants` 员工功能授权

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `user_id` | `integer` | NOT NULL → `base.users.id` | 被授权员工 |
| `function_code` | `text` | NOT NULL | 功能编码（不建外键：功能移除后历史授权行保留为审计数据） |
| `data_scope` | `enum data_scope` | NOT NULL | `SELF / DEPARTMENT / COMPANY` |
| `granted_by` | `integer` | NOT NULL → `base.users.id` | 授权操作者 |
| `granted_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 授权时间 |

无删除字段：批量撤销=物理删除行（审计由操作日志承载）。
- 唯一索引：`(user_id, function_code, data_scope)`——已覆盖所有以 `user_id` 开头的查询，不再单建查询索引（员工功能授权行数少、按功能编码反查授权人频率极低）
- 授权/撤销事务中同步递增 `base.users.permission_version`（同一平台核心事务）

### S-6 `permission_groups` 权限组（软删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `name` | `text` | NOT NULL，UNIQUE | 组名 |
| `description` | `text` | NULL | |
| `created_by` / `created_at` | | 基线 §2.1 | |
| `updated_by` / `updated_at` | | 基线 §2.1 | |
| `deleted_by` / `deleted_at` | | 基线 §2.1 | |

### S-7 `permission_group_items` 权限组明细

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `group_id` | `integer` | NOT NULL → `permission_groups.id` ON DELETE CASCADE | |
| `system_code` | `text` | NOT NULL | 系统编码（可跨系统） |
| `function_code` | `text` | NOT NULL | 功能编码 |
| `data_scope` | `enum data_scope` | NOT NULL | |

- 唯一索引：`(group_id, function_code, data_scope)`
- 组编辑=事务内全量替换明细；展开授权时按目录校验功能仍注册

## 3. 系统设置

### S-8 `system_settings` 系统设置项

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `key` | `text` | NOT NULL，UNIQUE | 参数键 |
| `value` | `text` | NOT NULL | 参数值（字符串化存储） |
| `value_type` | `enum setting_value_type` | NOT NULL | `STRING / NUMBER / BOOLEAN / JSON` |
| `group` | `enum setting_group` | NOT NULL | `PLATFORM / AI`（AI 配置随智能模块启用） |
| `label` | `text` | NOT NULL | 展示名称 |
| `sensitive` | `boolean` | NOT NULL `DEFAULT false` | 敏感参数（部署级主密钥加密存储，不明文展示） |
| `updated_by` | `integer` | NULL | |
| `updated_at` | `timestamptz` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

## 4. 系统日志

### S-9 `error_logs` 集中错误日志（聚合）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `level` | `enum log_level` | NOT NULL | `INFO / WARN / ERROR / CRITICAL` |
| `service` | `text` | NOT NULL | 所属服务 |
| `source` | `text` | NOT NULL | 来源（HTTP 路由模板 / `BACKGROUND_TASK:<类型>`） |
| `error_category` | `text` | NOT NULL | 错误分类 |
| `deploy_commit` | `text` | NOT NULL | 部署 commit |
| `fingerprint` | `text` | NOT NULL | 异常指纹（SHA-256，不含高基数/敏感值） |
| `bucket_start` | `timestamptz` | NOT NULL | 五分钟聚合时间桶起点 |
| `first_seen_at` | `timestamptz` | NOT NULL | 首次发生时间 |
| `last_seen_at` | `timestamptz` | NOT NULL | 最后发生时间 |
| `occurrence_count` | `integer` | NOT NULL `DEFAULT 1` | 发生次数 |
| `first_request_id` | `text` | NULL | 首个追踪标识 |
| `last_request_id` | `text` | NULL | 最近追踪标识 |
| `sample` | `text` | NULL | 脱敏异常样本（首个异常保留） |
| `status` | `enum error_status` | NOT NULL `DEFAULT PENDING` | `PENDING / HANDLED / IGNORED` |
| `handled_by` | `integer` | NULL → `base.users.id` | 处置人 |
| `handled_at` | `timestamptz` | NULL | 处置时间 |
| `remark` | `text` | NULL | 处理备注 |
| `updated_at` | `timestamptz` | NOT NULL | 聚合/处置更新 |

原始异常样本与聚合数据不可人工编辑；处置状态单向流转（`PENDING → HANDLED/IGNORED`）；系统可按主 PRD §9.1 日志保留策略按 `first_seen_at` 自动清理过期记录。
- 部分唯一索引：`(fingerprint, bucket_start) WHERE status = 'PENDING'`——并发聚合原子 UPSERT
- 查询索引：`(status, last_seen_at DESC)`（处置列表）
- 清理索引：`(first_seen_at)`（日志保留清理）

### S-10 `security_logs` 安全日志（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `event_type` | `enum security_event_type` | NOT NULL | 登录成功/失败、登出、账号锁/IP 锁、激活、邀请、密码修改/重置、手机号同步、内部令牌校验失败等 |
| `actor_id` | `integer` | NULL → `base.users.id` | 主体账号（匿名失败尝试可为 NULL） |
| `target_user_id` | `integer` | NULL → `base.users.id` | 目标账号 |
| `result` | `enum security_result` | NOT NULL | `SUCCESS / FAILURE` |
| `reason` | `text` | NULL | 失败安全化原因 |
| `source_ip` | `text` | NULL | 来源 IP |
| `context` | `jsonb` | NULL | 最小上下文（锁定时长、脱敏手机号等） |
| `request_id` | `text` | NULL | 追踪标识 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 事件时间 |

不记录密码、凭证、会话标识、邀请原文；系统可按主 PRD §9.1 日志保留策略按 `created_at` 自动清理过期记录。
- 清理索引：`(created_at)`（日志保留清理）；列表按 `id` 倒序即时间倒序

## 5. 统一后台任务

### S-11 `background_tasks` 统一后台任务事实表（只追加）

> 全平台唯一任务状态事实来源，兼作轻量 Outbox；BullMQ 仅负责唤醒执行。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `task_uuid` | `uuid` | NOT NULL，UNIQUE | 任务标识（BullMQ 稳定 jobId，应用层生成） |
| `task_type` | `text` | NOT NULL | 任务类型 |
| `module` | `text` | NOT NULL | 所属模块 |
| `initiator_id` | `integer` | NULL | 发起人（调度器=NULL） |
| `initiator_type` | `enum task_initiator_type` | NOT NULL | `USER / SCHEDULER` |
| `ref` | `jsonb` | NULL | 最小业务引用（不含敏感值） |
| `status` | `enum task_status` | NOT NULL `DEFAULT PENDING_ENQUEUE` | `PENDING_ENQUEUE / QUEUED / RUNNING / SUCCEEDED / FAILED / CANCELLED` |
| `progress` | `integer` | NOT NULL `DEFAULT 0` | 进度 0-100 |
| `started_at` | `timestamptz` | NULL | |
| `finished_at` | `timestamptz` | NULL | |
| `attempts` | `integer` | NOT NULL `DEFAULT 0` | 尝试次数 |
| `next_retry_at` | `timestamptz` | NULL | 下次投递/重试时间 |
| `timeout_at` | `timestamptz` | NULL | 超时时间 |
| `lease_owner` | `text` | NULL | 执行租约持有者 |
| `lease_expires_at` | `timestamptz` | NULL | 执行租约到期时间 |
| `last_error` | `text` | NULL | 脱敏后错误 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

MVP 不自动清理、不提供删除接口。
- 扫描索引：`(status, next_retry_at)`、`(status, lease_expires_at)`
- 部分索引：`(finished_at DESC) WHERE status = 'FAILED'`——最近 24 小时失败汇总

## 6. 更新日志与系统公告

### S-12 `release_logs` 更新日志（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `release_id` | `text` | NOT NULL，UNIQUE | 唯一发布标识（重试不重复生成） |
| `version` | `text` | NOT NULL | 版本号 |
| `commit_sha` | `text` | NOT NULL | 全平台部署 Git commit |
| `commit_subjects` | `jsonb` | NULL | 提交范围变更说明（Conventional Commits 标题列表） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 发布时间 |

仅发布流程自动追加，不允许手工增删改。

### S-13 `announcements` 系统公告（软删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `title` | `text` | NOT NULL | 标题（纯文本） |
| `content` | `text` | NULL | 内容（纯文本，保留换行，不解析 HTML） |
| `status` | `enum announcement_status` | NOT NULL `DEFAULT DRAFT` | `DRAFT / PUBLISHING / REVOKED` |
| `published_at` | `timestamptz` | NULL | 最近发布时间 |
| `publisher_id` | `integer` | NULL → `base.users.id` | 发布人 |
| `created_by` / `created_at` | | 基线 §2.1 | |
| `updated_by` / `updated_at` | | 基线 §2.1 | |
| `deleted_by` / `deleted_at` | | 基线 §2.1 | |

- 部分唯一索引：`(status) WHERE status = 'PUBLISHING' AND deleted_at IS NULL`——全平台同时最多一条"正在展示"

## 7. 数据备份与恢复

### S-14 `backups` 备份记录

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `task_uuid` | `uuid` | NULL | 关联 `background_tasks.task_uuid` |
| `task_type` | `enum backup_type` | NOT NULL | `SCHEDULED / IMMEDIATE / EMERGENCY` |
| `status` | `enum backup_status` | NOT NULL `DEFAULT RUNNING` | `RUNNING / SUCCEEDED / FAILED` |
| `backup_time` | `timestamptz` | NOT NULL | 备份数据时间点 |
| `pg_version` | `text` | NULL | PostgreSQL 版本 |
| `file_size` | `bigint` | NULL | 文件大小（字节） |
| `checksum` | `text` | NULL | SHA-256 校验和 |
| `oss_object_key` | `text` | NULL | OSS 备份对象标识 |
| `oss_manifest_key` | `text` | NULL | OSS 最小清单对象标识 |
| `error` | `text` | NULL | 脱敏错误信息 |
| `started_at` | `timestamptz` | NOT NULL | |
| `finished_at` | `timestamptz` | NULL | |
| `created_by` | `integer` | NULL → `base.users.id` | 发起人（调度=NULL） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

按保留天数物理清理（目录记录、OSS 对象与清单一并清理）。

### S-15 `restores` 恢复记录（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `restore_uuid` | `text` | NOT NULL，UNIQUE | 稳定恢复标识（与外部恢复控制清单一致） |
| `backup_id` | `integer` | NULL → `backups.id` ON DELETE SET NULL | 所选备份 |
| `emergency_backup_id` | `integer` | NULL → `backups.id` ON DELETE SET NULL | 恢复前紧急备份 |
| `status` | `enum restore_status` | NOT NULL `DEFAULT PENDING` | `PENDING / PRECHECK / MAINTENANCE / RESTORING / SUCCEEDED / FAILED` |
| `stage` | `text` | NULL | 当前阶段 |
| `initiated_by` | `integer` | NOT NULL → `base.users.id` | 发起人（超级管理员） |
| `initiated_at` | `timestamptz` | NOT NULL | |
| `finished_at` | `timestamptz` | NULL | |
| `error` | `text` | NULL | 脱敏错误 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

## 8. 统一审批契约

> 通用审批头契约，backstage / hr / asset 各模块在自身 schema 维护同构的 `approval_requests` 与 `approval_actions`，业务明细存于各业务明细表。

### S-16 `approval_requests` 审批头（通用契约）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `application_no` | `text` | NOT NULL，UNIQUE | 申请编号 |
| `request_type` | `enum`（各模块定义） | NOT NULL | 申请类型 |
| `applicant_id` | `integer` | NOT NULL | 申请人（平台核心内 → `base.users.id`；独立服务无外键） |
| `applicant_name` | `text` | NOT NULL | 申请人姓名快照 |
| `applicant_department_snapshot` | `jsonb` | NULL | 申请人提交时部门快照 `[{id, name}]` |
| `proxy_id` | `integer` | NULL | 代交人 |
| `proxy_name` | `text` | NULL | 代交人姓名快照 |
| `ref_request_id` | `integer` | NULL | 业务记录标识（如代领结清→代领清单申请 ID） |
| `status` | `enum approval_status` | NOT NULL `DEFAULT DRAFT` | `DRAFT / PENDING / APPROVED / REJECTED / CANCELLED`（不支持草稿的类型直接进入 PENDING） |
| `version` | `integer` | NOT NULL `DEFAULT 1` | 版本号（"当前状态+版本号"条件更新） |
| `submitted_at` | `timestamptz` | NULL | 提交时间 |
| `cancelled_by` | `integer` | NULL | 取消操作者 |
| `cancelled_at` | `timestamptz` | NULL | 取消时间 |
| `cancel_source` | `enum cancel_source` | NULL | `USER / ACCOUNT_DEACTIVATED / OVERDUE`（用户取消 / 注销自动取消 / 超时自动取消） |
| `processor_id` | `integer` | NULL | 处理人 |
| `processor_name` | `text` | NULL | 处理人姓名快照 |
| `processed_at` | `timestamptz` | NULL | 处理时间 |
| `opinion` | `text` | NULL | 处理意见（驳回必填原因） |
| `created_by` | `integer` | NULL | 申请人（创建者） |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 申请创建时间 |
| `updated_by` | `integer` | NULL | 最后更新操作者（与 `approval_actions` 操作者冗余，便于审批头直接展示） |
| `updated_at` | `timestamptz` | NOT NULL | 状态流转时间 |

审批记录不可删除（无 `deleted_*`）。
- 查询索引：`(status, submitted_at)`、`(applicant_id)`、`(processor_id)`、`(request_type, status)`
- 各模块业务键待审批限制在本表建条件唯一索引（见各模块文档）

### S-17 `approval_actions` 审批处理记录（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` | |
| `action` | `enum approval_action` | NOT NULL | `SUBMIT / CANCEL / APPROVE / REJECT / AUTO_CANCEL` |
| `actor_id` | `integer` | NOT NULL | 操作者 |
| `actor_name` | `text` | NOT NULL | 操作者姓名快照 |
| `opinion` | `text` | NULL | 当次意见 |
| `cancel_source` | `enum cancel_source` | NULL | 自动取消来源 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

处理记录时间线按此表展示。

### S-18 `profile_change_requests` 资料修改申请明细（backstage）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `request_id` | `integer` | NOT NULL → `approval_requests.id` ON DELETE CASCADE | |
| `user_id` | `integer` | NOT NULL → `base.users.id` | 目标员工（=申请人） |
| `user_name` | `text` | NOT NULL | 姓名快照 |
| `department_snapshot` | `jsonb` | NULL | 提交时部门快照 |
| `old_name` | `text` | NOT NULL | 修改前姓名 |
| `new_name` | `text` | NOT NULL | 修改后姓名 |
| `old_gender` | `enum gender` | NOT NULL | 修改前性别 |
| `new_gender` | `enum gender` | NOT NULL | 修改后性别 |

一张申请一条明细（1:1）。
- 待审批数量限制（本模块）：`approval_requests` 部分唯一索引 `(applicant_id) WHERE request_type = 'PROFILE_CHANGE' AND status = 'PENDING'`——同一员工同时最多一条待审批资料修改申请

## 9. 操作日志

### S-19 `operation_logs`（backstage schema）

结构与 `base.operation_logs`（B-4）完全一致，只写本模块日志；联合只读视图汇总全模块日志；支持按主 PRD §9.1 日志保留策略自动清理。

## 10. 用户表格偏好

### S-20 `user_table_prefs`（backstage 页面偏好）

不单独建表：backstage 与 base 同属 `platform-core`，页面偏好（筛选预设 + 列设置，主 PRD §10.2）统一存储于 `base.user_table_prefs`（B-5），以 `page_key` 区分功能页。

**表间关系**：`systems` 1—N `business_sections` 1—N `functions`；`permission_groups` 1—N `permission_group_items`；`approval_requests` 1—N `approval_actions`、1—1 `profile_change_requests`；`backups`/`restores` 关联 `background_tasks`；表格偏好引用 `base.user_table_prefs`（B-5）。

## 11. 系统菜单配置

### S-21 `system_menu_groups` 系统导航分组展示配置（每分组一行）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `system_code` | `text` | NOT NULL | 所属系统（`BACKSTAGE / ASSET / HR / FIN`） |
| `node_key` | `text` | NOT NULL | 分组稳定标识 = 代码默认名按层级用 `/` 连接（如 `消耗品`、`消耗品/消耗品申领`）；改名与层级调整均不改变标识 |
| `parent_key` | `text` | NULL | 直接父分组 `node_key`（NULL = 顶层分组；分组可嵌套到任意深度，唯一限制是不成环；应用层引用，不建外键） |
| `name_override` | `text` | NULL | 显示名覆盖；NULL 表示使用代码默认名 |
| `sort_order` | `integer` | NOT NULL | 同级排序序号 |
| `updated_by` | `integer` | NULL | |
| `updated_at` | `timestamptz` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- 唯一约束：`(system_code, node_key)`

### S-22 `system_menu_items` 系统导航菜单项展示配置（每菜单项一行）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `system_code` | `text` | NOT NULL | 所属系统 |
| `item_key` | `text` | NOT NULL | 菜单项标识（前端导航项 key）；路径、权限与默认名仍由代码定义，本表仅存展示层配置 |
| `parent_key` | `text` | NULL | 直接父分组 `node_key`（NULL = 顶层叶子，顶层叶子与分组共享同一顺序轴；菜单项可挂在任意层级的分组下；应用层引用，不建外键） |
| `name_override` | `text` | NULL | 显示名覆盖；NULL 表示使用代码默认名 |
| `sort_order` | `integer` | NOT NULL | 同级排序序号 |
| `updated_by` | `integer` | NULL | |
| `updated_at` | `timestamptz` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

- 唯一约束：`(system_code, item_key)`
- 两表按系统整树单事务替换，不增删分组与菜单项本身；某系统无任何配置行时前端回退代码默认导航，「恢复默认」即删除该系统全部配置行。
- 显示名按字符串渲染聚合：两个同级分组解析出同名（改名撞名或移动后默认名撞车）会在侧边导航视觉上合并为一个菜单，通过改名解消；跨分支同名分组互不影响。

## 12. 只读视图（Migration Runner 迁移后统一执行，脚本见 `scripts/db-views/`）

- **`backstage.site_roles`**（01-site-roles.sql，主 PRD §9.4、backstage PRD §8）：站点角色最小只读视图 = `base.users` 的 `user_id / name / is_super_admin / status`（`deleted_at IS NULL`）；hr 等其它部署单元经此视图读取站点角色，不直连 users 表。
- **`backstage.operation_logs_union`**（02-operation-logs-union.sql，主 PRD §3.3）：base/backstage/asset/hr/fin 各 schema 同构 `operation_logs` 的联合视图，`action_type` 统一转 `text`；新增模块时必须同步扩展。
- **hr `user_titles`**（03-user-titles.sql，hr PRD §8）：职称视图归 hr 部署单元（见 `hr.md`）。
