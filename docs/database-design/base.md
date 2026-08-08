# WBME 数据库表设计：base 模块

> schema：`base`，归属部署单元 `platform-core`（与 backstage 同一 Prisma Client、同一迁移序列）。
> 表结构遵循 `00-baseline.md` 公共基线。
> 服务端会话存储在 Redis，不建会话表；`users.session_version` 持久化会话版本号。
> **字段约束语义**：本文与 `backstage.md` 中 `→ xxx.id` 表示逻辑引用（同部署单元内可由 Prisma 关系建立物理外键；跨部署单元或仅作审计留存的字段为逻辑引用，不建物理外键），实际物理外键以 Prisma schema 与迁移 SQL 为准。

## B-1 `users` 用户（软删除）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `name` | `text` | NOT NULL，≤50 | 姓名 |
| `gender` | `enum gender` | NOT NULL | `MALE / FEMALE` |
| `phone` | `text` | NOT NULL | 规范化存储（国家码+号码） |
| `password_hash` | `text` | NULL | Argon2id 哈希；待激活账号为 NULL |
| `status` | `enum user_status` | NOT NULL `DEFAULT PENDING_ACTIVATION` | `PENDING_ACTIVATION / ACTIVE / DEACTIVATED` |
| `is_super_admin` | `boolean` | NOT NULL `DEFAULT false` | 站点角色（超级管理员/员工） |
| `session_version` | `integer` | NOT NULL `DEFAULT 0` | 会话版本号：修改/重置密码、注销时递增 |
| `permission_version` | `integer` | NOT NULL `DEFAULT 0` | 账号授权版本：backstage 授权事务中递增 |
| `lifecycle_version` | `integer` | NOT NULL `DEFAULT 0` | 账号生命周期版本：注销/恢复等生命周期变更时递增（恢复确认请求携带校验） |
| `restored_by` | `integer` | NULL | 恢复人 |
| `restored_at` | `timestamptz` | NULL | 恢复时间 |
| `created_by` | `integer` | NULL | 创建者；系统/初始化=NULL |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |
| `updated_by` | `integer` | NULL | |
| `updated_at` | `timestamptz` | NOT NULL | |
| `deleted_by` | `integer` | NULL | 注销操作人 |
| `deleted_at` | `timestamptz` | NULL | 注销时间；NULL=有效 |

**约束与索引**
- 部分唯一索引：`(phone) WHERE status IN ('PENDING_ACTIVATION','ACTIVE') AND deleted_at IS NULL`——手机号唯一仅限"待激活+正常"，注销手机号转为历史快照
- CHECK：`status <> 'ACTIVE' OR password_hash IS NOT NULL`——正常账号必有密码
- 最后一名超级管理员保护由应用层事务内校验，数据库不表达

## B-2 `activation_invitations` 账号激活邀请（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `user_id` | `integer` | NOT NULL → `users.id` | 待激活账号 |
| `token_hash` | `text` | NOT NULL | 凭证摘要（SHA-256）；原文不落库 |
| `status` | `enum invitation_status` | NOT NULL `DEFAULT VALID` | `VALID / USED / REVOKED` |
| `expires_at` | `timestamptz` | NOT NULL | 有效期（默认 7 天，系统设置可调） |
| `used_at` | `timestamptz` | NULL | 使用时间 |
| `revoked_at` | `timestamptz` | NULL | 失效时间（重新生成时置旧邀请） |
| `created_by` | `integer` | NULL → `users.id` | 生成人（管理员）；部署初始化=NULL |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |

**约束与索引**
- 部分唯一索引：`(user_id) WHERE status = 'VALID'`——同一账号最多一个有效邀请
- 到期不更新行，由服务端校验 `expires_at`

## B-3 `dingtalk_bindings` 钉钉身份绑定（只追加）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `user_id` | `integer` | NOT NULL → `users.id` | 平台账号 |
| `dingtalk_union_id` | `text` | NOT NULL | 钉钉稳定唯一用户标识 |
| `status` | `enum binding_status` | NOT NULL `DEFAULT BOUND` | `BOUND / UNBOUND`（UNBOUND 为保留值：本期无换绑/解绑操作，不产生） |
| `unbound_at` | `timestamptz` | NULL | 解绑时间（本期不产生，保留兼容） |
| `created_by` | `integer` | NULL | 绑定发起者；激活流程=NULL |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 绑定时间 |

**约束与索引**
- 唯一索引：`(dingtalk_union_id)` 全局唯一——一个钉钉身份永不重绑（含已注销、已解绑历史）
- 部分唯一索引：`(user_id) WHERE status = 'BOUND'`——一个账号同时最多一条有效绑定

## B-4 `operation_logs` 操作日志（只追加，各模块同构）

> 统一字段结构，base/backstage/asset/hr/fin 各在自身 schema 维护一份；管理后台经只读联合视图汇总。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `operator_id` | `integer` | NULL | 操作者；系统/后台任务操作可为 NULL |
| `operator_name` | `text` | NULL | 操作者姓名快照 |
| `operator_departments` | `jsonb` | NULL | 操作时全部归属部门快照 `[{id, name}]` |
| `system` | `text` | NOT NULL | `BASE / BACKSTAGE / ASSET / HR / FIN` |
| `feature` | `text` | NOT NULL | 功能编码 |
| `action_type` | `enum log_action` | NOT NULL | `CREATE / UPDATE / DELETE / EXPORT` |
| `summary` | `text` | NOT NULL | 按功能摘要模板生成的正文 |
| `idempotency_scope` | `text` | NULL | 幂等作用域 |
| `idempotency_key` | `text` | NULL | 幂等键 |
| `request_fingerprint` | `text` | NULL | 规范化请求指纹 |
| `result_reference` | `jsonb` | NULL | 最小结果引用 |
| `request_id` | `text` | NULL | 追踪标识 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | 操作时间 |

**约束与索引**
- 部分唯一索引（幂等）：`(COALESCE(operator_id, 0), system, idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL`
- 查询索引：`(system, created_at)`、`(operator_id, created_at)`

## B-5 `user_table_prefs` 用户表格偏好（物理删除）

> 全站表格「筛选预设 + 列设置」的服务端持久化（主 PRD §10.2）。base 与 backstage 同属 `platform-core`、共用一张本表（`page_key` 区分功能页）；asset / hr / fin 各自 schema 维护同构表。
> 不遵循 §2.1 审计模板：操作者恒为本人（= `user_id`），无删除审计需求，删除=物理删除，不记操作日志（非业务数据变更）。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | |
| `user_id` | `integer` | NOT NULL → `base.users.id` | 偏好归属人（个人私有） |
| `page_key` | `text` | NOT NULL | 功能页标识（开发定义，如 `backstage:operation-logs`） |
| `pref_type` | `enum table_pref_type` | NOT NULL | `FILTER_PRESET / COLUMN_SETTING` |
| `name` | `text` | NULL | 预设名称（FILTER_PRESET 必填；COLUMN_SETTING 无名称） |
| `content` | `jsonb` | NOT NULL | 筛选预设：条件/排序组合；列设置：列显隐/宽度/固定 |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` | |
| `updated_at` | `timestamptz` | NOT NULL | |

**约束与索引**
- 部分唯一索引：`(user_id, page_key, name) WHERE pref_type = 'FILTER_PRESET'`——同一页面同名预设唯一
- 部分唯一索引：`(user_id, page_key) WHERE pref_type = 'COLUMN_SETTING'`——每页一条列设置
- 两个部分唯一索引均以 `user_id` 开头，已覆盖"某用户某页偏好"查询，不再单建查询索引
- 预设重命名/删除 = 物理删除行

**表间关系**：`users` 1—N `activation_invitations`；`users` 1—N `dingtalk_bindings`；`operation_logs` 独立（`operator_id` 逻辑引用用户）；`user_table_prefs` 独立（`user_id` 逻辑引用用户）。
