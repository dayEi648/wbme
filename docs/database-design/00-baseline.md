# WBME 数据库表设计规范（公共基线）

> 本文档定义全平台数据库表设计的公共规范，所有模块表结构遵循本基线。
> 模块级表设计见同目录下各模块文档（`base.md`、`backstage.md`、`hr.md`、`asset.md`、`fin.md`）。

## 1. 通用规则

- **schema 归属**：按逻辑模块划分 schema（`base`/`backstage` 归属部署单元 `platform-core`；`asset`/`hr`/`fin` 为独立部署单元），Prisma 模型通过 `@@schema` 声明归属；跨 schema 读写遵循主 PRD §9.4。
- **主键**：`integer` 自增（serial4，Prisma `@default(autoincrement())`），与 TypeScript `number` 直接映射，业务代码无需转换。
- **命名**：表名 `snake_case` 复数；字段 `snake_case`；时间字段 `_at` 后缀、操作者字段 `_by` 后缀、外键 `{target}_id`；Prisma 模型名 PascalCase 单数 + `@@map` 映射表名。
- **时间**：时间点 `timestamptz`（UTC 存储）；自然日 `date`；业务周期边界按 `Asia/Shanghai` 计算。
- **金额与数量**：金额 `numeric(18,2)`；比率 `numeric(12,8)`；业务数量 `integer` + 范围 CHECK（库存余额 ≥ 0、变动数量为正整数）。
- **状态字段**：Prisma enum 映射 PostgreSQL enum，TypeScript 侧为 string union。
- **TS 类型映射**：字段类型优先选择与 TypeScript 原生类型直接映射的类型，业务代码中无需转换；金额与比率按主 PRD §9.11 使用 Prisma `Decimal`，仅在 API 边界序列化为十进制字符串。

| PostgreSQL | Prisma | TypeScript | 用途 |
| --- | --- | --- | --- |
| `integer`（serial4 自增） | `Int @id @default(autoincrement())` | `number` | 主键、外键、业务数量 |
| `text` / `varchar` | `String` | `string` | 名称、摘要、快照、哈希等 |
| `boolean` | `Boolean` | `boolean` | 标志位 |
| `timestamptz` | `DateTime` | `Date` | 时间点（UTC）；API 边界序列化为 RFC 3339 字符串 |
| `date` | `DateTime @db.Date` | `Date` | 自然日 |
| `numeric(18,2)` | `Decimal @db.Decimal(18,2)` | `Prisma.Decimal` | 金额（禁止 float） |
| `numeric(12,8)` | `Decimal @db.Decimal(12,8)` | `Prisma.Decimal` | 比率 |
| enum | Prisma enum | string union | 状态、类型字段 |
| `jsonb` | `Json` | `JsonValue` | 快照、结构化数据 |
- **快照原则**：被引用的可删配置数据（部门、岗位、字典、分类、库位、品种等）不建立外键关联，业务记录保存提交/发生时的名称等文字快照。
- `updated_at` 由应用层在更新时写入，不建数据库触发器。

## 2. 审计字段模板

### 2.1 软删除表（普通业务实体）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | 主键 |
| `created_by` | `integer` | NULL | 创建者；NULL 表示系统/初始化操作 |
| `created_at` | `timestamptz` | NOT NULL，`DEFAULT now()` | 创建时间（UTC） |
| `updated_by` | `integer` | NULL | 最后修改者 |
| `updated_at` | `timestamptz` | NOT NULL | 最后修改时间，应用层维护 |
| `deleted_by` | `integer` | NULL | 软删除者（注销/删除操作人） |
| `deleted_at` | `timestamptz` | NULL | NULL=有效；非 NULL=已软删除 |

### 2.2 只追加表（日志、流水、审计、任务事实）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `integer` | PK，serial4 自增 | 主键 |
| `created_by` | `integer` | NULL | 创建者/操作者；系统操作可为 NULL |
| `created_at` | `timestamptz` | NOT NULL，`DEFAULT now()` | 创建/发生时间 |

无 `updated_*`/`deleted_*` 字段；状态变化使用业务字段（如 `status`、`used_at`）表达，后端不提供修改或删除能力；操作日志、错误日志与安全日志可按主 PRD §9.1 日志保留策略由 Worker 自动物理清理。`created_by` 是否必需由各表业务决定。

## 3. 删除策略

| 类别 | 模板 | 范围 |
| --- | --- | --- |
| 软删除 | §2.1 | 普通业务实体（用户、公告、审批申请、资产、消耗品、库存批次等） |
| 物理删除 | §2.1 无 `deleted_*` | 配置类数据：字典、分类、库位、部门、岗位、品种；删除前返回引用确认，部门/岗位的当前业务引用在事务内置空 |
| 只追加 | §2.2 | 操作日志、系统日志、安全日志、库存流水、审批处理记录、后台任务事实表、激活邀请、钉钉绑定历史 |
| 保留策略清理 | — | 备份记录及其 OSS 对象、清单按保留天数物理清理 |
| 日志保留策略清理 | — | 操作日志（保留 `idempotency_key IS NOT NULL` 的行）、错误日志、安全日志按系统设置保留天数由 Worker 物理清理 |

## 4. 外键策略

- **platform-core 内**（`base`/`backstage`，同一部署单元、同一迁移序列）：允许建立外键（如审计字段 → `base.users`）。
- **独立服务**（`asset`/`hr`/`fin`，独立迁移历史）：不建立跨 schema 外键，跨模块引用只存目标 ID，展示所需信息按快照原则存快照字段。
- 配置类数据被引用时不建外键，存文字快照。

## 5. 唯一性与并发

- 软删除表的业务键唯一性使用**部分唯一索引**（`WHERE deleted_at IS NULL`）；状态相关唯一性同样使用条件唯一索引（如手机号唯一仅限"待激活 + 正常"状态）。
- 部分唯一索引中 NULL 值不参与唯一比较；需要 NULL 值参与唯一约束时使用 `COALESCE` 表达式（如操作日志幂等键以 0 兜底系统操作）。
- 审批"同一业务键最多一条待审批"的并发正确性由条件唯一索引保证（主 PRD §3.2），不依赖 Redis 锁。

## 6. 文件存储与临时图片清理

- 图片对象键与业务记录的关联见各模块表（`assets.image_oss_key`、`consumables.image_oss_key`），对象本身不建元数据表。
- 未关联业务的临时上传对象**不建表**：上传时在 Redis 记录待清理键（含提交时保留时长快照）；Worker 清理时除消费该记录外，还必须**分页列举固定图片前缀下超过保留期的对象，并与当前数据库全部正式/历史图片引用做差集**兜底（主 PRD §9.2），Redis 丢失时凭差集重建待清理对象；每个候选对象删除前再次确认仍无任何正式或历史引用。
- 数据库备份对象的管理见 backstage.md §S-14，不进入本规则。
