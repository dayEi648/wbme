# 阶段 7：asset 服务开发计划

## Context

WBME 项目处于 MVP 阶段 7——**资产系统后端全功能**（`apps/asset`）。阶段 0-6 已交付：工程基座、数据库（asset 30 表 Prisma schema 已落地）、base 认证、backstage 权限、平台基础设施（日志/任务/导出/表格偏好）、统一审批契约（T5-3 已接入 asset 审批头，批准副作用为 no-op）、hr 服务（阶段 6 完整参考模板）。

按 `.agents/plans/实现规划.md` 实现 **T7-1 ~ T7-11**（asset PRD 全部），并清欠：**T4-12 挂账的 A-30 表格偏好 stub**、**T7-8 配套的 worker 超时扫描占用释放 hook**。完成后 git 提交并推送（用户已授权）。

**核心挑战**：库存/额度/借还占用一致性（事务 + 固定顺序锁 + 咨询锁 + FIFO）、六类审批的业务副作用接线、注销员工直接处置互斥、二维码不透明标识。

## 关键事实（已调研确认）

- **无新表**：A-1~A-30 全部落在 `apps/asset/prisma/asset.prisma`（含条件唯一索引与 CHECK 的迁移 SQL）。
- **缺一个迁移**：asset `operation_logs` 表缺 `operation_logs_idempotency_unique` 部分唯一索引（hr 有、asset 无）——没有它 `executeIdempotentOperation` 的并发去重兜底失效。**需补一个只建索引的迁移**（SQL 照 hr 迁移 20260808082629_init:415，schema 换 asset；不在 schema 声明，防 migrate diff 噪音）。
- asset 现有：`main.ts/app.module.ts/shared.module.ts` 与 hr 同构；approval 模块（审批头/列表/详情/待办已实现，副作用 no-op，部门闭包标注延期）；`table-prefs.controller.stub.ts` 占位；`cross-schema-auth.ts` 缺 `assertFunctionAccess`；无 openapi 生成器、无 operation-log util、无闭包服务。
- hr 是完整模板：模块组织（controller+module+service+spec）、DTO 集中在 `packages/contracts/src/dto/`、service 层 `assertFunctionAccess`、`ApprovalSideEffect` + forwardRef 注册、`executeIdempotentOperation` 幂等（`hr-operation-log.util.ts`）、`runExport` 导出、真实 PG 集成测试、`generate-openapi.ts`。
- 部门闭包跨 schema 查 `hr.department_closure` / `hr.user_org` 视图（hr 的 `department-closure.service.ts` 照抄）。
- worker `approval-timeout.processor.ts` 当前只做审批状态迁移；`@wbme/approval/src/timeout.ts` 无 hook、无事务。
- 权限目录已含 ASSET 15 功能；错误码已有 asset 域 6 个 + inventory 域 9 个。

## 实施步骤

### 第 1 组：契约与基础设施（前置）
1. **迁移**：`apps/asset/prisma/migrations/20260809xxxx_add_operation_logs_idempotency_unique/migration.sql`——asset 版幂等唯一索引。
2. **权限编码常量**：`packages/contracts/src/permission/catalog.ts` 补 14 个功能编码（`MY_ASSETS_FUNCTION_CODE`、`FIXED_ASSET_VIEW_FUNCTION_CODE`、`FIXED_ASSET_MAINTAIN_FUNCTION_CODE`、`CONSUMABLE_APPLY_FUNCTION_CODE`、`CONSUMABLE_APPLY_HISTORY_FUNCTION_CODE`、`PROXY_APPLY_FUNCTION_CODE`、`MY_BORROW_FUNCTION_CODE`、`BORROW_HISTORY_FUNCTION_CODE`、`INVENTORY_MANAGE_FUNCTION_CODE`、`STOCK_IN_APPLY_FUNCTION_CODE`、`STOCK_IN_HISTORY_FUNCTION_CODE`、`STOCK_CHANGE_APPLY_FUNCTION_CODE`、`STOCK_CHANGE_HISTORY_FUNCTION_CODE`、`ASSET_CONFIG_FUNCTION_CODE`；风格对齐 hr）。
3. **错误码**：`errors/domains/asset.ts` 增 `ASSET_TRANSFER_NO_CHANGE`/`CATEGORY_REFERENCED`/`DICT_REFERENCED`；`errors/domains/inventory.ts` 增 `CONSUMABLE_DISABLED`/`LOCATION_REFERENCED`/`BORROW_ALREADY_SETTLED`/`SETTLEMENT_COVERAGE_INCOMPLETE`/`DISPOSAL_FORBIDDEN`/`RECIPIENT_INVALID`（命名对齐 hr）。
4. **共享层**（`apps/asset/src/shared/`）：
   - `cross-schema-auth.ts` 补齐 `assertFunctionAccess`（照 hr，RESOURCE_NOT_FOUND/SYSTEM_NOT_OPEN）。
   - `asset-operation-log.util.ts`（移植 hr：`loadAssetOperationLogOperator`/`executeIdempotentOperation`/`fingerprintPayload`/`writeAssetOperationLog`，system='ASSET'，模型 `assetOperationLog`）。
   - `department-closure.service.ts`（照抄 hr，注册到 SharedModule）。
   - `inventory-core.ts`：`lockInventoryItems(tx, ids)`（id 升序 FOR UPDATE）、`allocateFifoBatches(tx, itemId, qty)`（received_at,id 升序 FOR UPDATE 扣段）、`writeStockFlow(...)`、`cleanupEmptyItem(tx, id)`。
   - `quota-period.ts`：`computeCycleKey(now, cycle, resetDay)`（北京时间 UTC+8，MONTH '2026-08'/QUARTER '2026-Q3'/YEAR '2026'，重置日归属周期起点）、`acquireQuotaAdvisoryLocks(tx, keys)`（`pg_advisory_xact_lock` 串行化额度并发）。
5. **DTO**（`packages/contracts/src/dto/` 新增，均 class-validator + @ApiProperty，写操作继承 `IdempotentDto`、列表继承 `PaginationQueryDto`）：
   - `asset-catalog.dto.ts`（分类/字典 CRUD + 批量删除 + 查询）
   - `asset-config.dto.ts`（扫码入口、重置日 1~28）
   - `fixed-asset.dto.ts`（建档/编辑/查询/我的资产 scope/批量软删/报废确认/调度）
   - `repair.dto.ts`（登记/开始/完成/查询）
   - `consumable.dto.ts`（品种 CRUD/批量删除/查询/申领目录）
   - `warehouse.dto.ts`（库位 CRUD/移动/批量删除/查询）
   - `inventory.dto.ts`（条目/批次查询、`BatchCorrectionDto`、流水查询）
   - `inventory-transfer.dto.ts`（调拨 create extends IdempotentDto + 查询）
   - `stock-in.dto.ts` / `stock-change.dto.ts`（清单式申请 + 查询）
   - `consumable-request.dto.ts`（普通申领 + 代交申领 + 本人/范围历史查询）
   - `borrow.dto.ts`（归还/核销申请 + 我的借还/借还历史查询）
   - `agent-settlement.dto.ts`（代领结清 + 查询）
   - `disposal.dto.ts`（直接处置 RETURN/WRITE_OFF/AGENT_SETTLE + 待处置/记录查询）
   - `qr.dto.ts`（创建/查询/解析/停用/恢复/重新生成）

### 第 2 组：业务模块（按依赖序，每模块 controller+module+service(s)+spec，权限在 service 用 `assertFunctionAccess`，写操作走幂等 util，列表走分页）
6. **配置/分类/字典**（T7-11）：`modules/settings/`（A-28 运行参数）+ `modules/catalog/`（A-1 分类、A-2 字典，批量硬删除引用检查）。
7. **品种/库位**（T7-3）：`modules/consumable/`（A-8：类型不可变、单位锁定、额度参数快照、删除限制——当前库存/未结清借还/待审批引用整批拒绝）+ `modules/warehouse/`（A-9：树、父子循环禁止、子库位存在禁删、停用库位不能作新目标）。
8. **库存条目/批次/纠正/流水**（T7-4）：`modules/inventory/`（A-10/A-11/A-12/A-13：条目汇总、批次列表、纠正——供应商/品牌/单价/备注直接纠+记录前后值；规格/库位仅无后续流水且无待审批占用时可纠；流水列表+导出复用 T4-11）。
9. **入库/库存变更申请**（T7-6）：`modules/request/`（A-18/A-19：清单式提交、入库提交不占用、变更提交占用 `reserved_qty`；域服务的 `applyApproved`/`applyRelease` 方法在此实现，接线在第 13 步）。
10. **轻量调拨**（T7-5）：`modules/transfer/`（A-14/A-15：幂等键、事务内按来源条目升序锁定重算可用量、超限 CONFLICT、FIFO 分配、目标建 `source_batch_id` 子批次、TRANSFER_OUT/IN 成对流水、总量不变、不可编辑删除）。
11. **消耗品申领**（T7-7）：`modules/claim/`（A-20/A-21/A-22：普通申领=库存占用+额度占用原子（咨询锁）、整单全有或全无、代交不占额度/不选自己/受领人名单、快照持久化）。
12. **借还/归还/核销/结清**（T7-8）：`modules/borrow/`（A-23/A-24/A-25：借还记录生成（due_at=出库+归还期限快照）、归还/核销申请（可申请=未结清−待审批归还−待审批核销）、批准 RETURN 回库到原批次（按 ISSUE 流水段恢复）、WRITE_OFF 不回库、代领结清全量覆盖校验 + 部分唯一索引 PENDING_LIMIT_REACHED）。
13. **注销员工直接处置**（T7-9）：`modules/disposal/`（A-26：非审批类型、事务内重校验注销状态/数据范围（PERSONAL 借出时部门快照闭包、AGENT_SETTLE 受领人名单闭包）/可处理数量、直接归还回库+流水、直接核销不回库、幂等键、恢复账号拒绝）。
14. **二维码**（T7-10）：`modules/qr/`（A-27：`randomBytes(32).toString('base64url')` 公开标识、三种目标、停用/恢复/作废重新生成（REVOKED 终态、部分唯一索引）、解析接口限流 + 不泄露目标详情 + 日志脱敏）。
15. **固定资产台账/维修**（T7-1/T7-2）：`modules/asset/`（A-3/A-4/A-5：建档/编辑/批量软删（业务关联整批拒绝）/报废（业务状态可恢复、记录前后值）/调度（部门+责任人变化强制、目标责任人属目标部门、无变化拒绝）/台账导出 runExport）+ `modules/repair/`（A-6/A-7：登记/取消/开始/完成状态+版本条件更新、仅 IDLE/IN_USE 可登记、取消恢复 pre_status、并发条件唯一索引→MAINTENANCE_ACTIVE_EXISTS）。

### 第 3 组：审批接线 + worker hook + 挂账
16. **审批副作用接线**：
    - `modules/approval/approval-side-effect.ts`（新接口：`applyApprove(tx, head, processorId)` + `applyRelease(tx, head)`——asset 特有，REJECT/取消也释放占用）。
    - `modules/approval/asset-approval-side-effect.ts`（编排器：按 requestType 分派六域服务的 applyApproved/applyRelease；STOCK_IN 批准建批次+流水、STOCK_CHANGE 批准 FIFO 扣减/驳回释放、申领批准出库+额度 CONSUMED+借还记录/驳回释放、RETURN/WRITE_OFF/AGENT_SETTLEMENT 相应处理；驳回与 USER 取消释放占用与终态同事务）。
    - `asset-approval.service.ts` 改造：process/cancel 接入副作用；**DEPARTMENT 档部门闭包过滤**（申请人快照 / agent_recipients / borrow_record 快照，复用 `@wbme/approval` 的 `toApproverScope`/`assertScopeCoversAll` + `closureOfUser`）；审批中心导出端点（runExport，可见性与列表一致）。
    - `approval.module.ts` forwardRef 互引业务模块；业务模块 exports 服务；审批头创建封装为 approval 模块导出的 `submitApprovalHead(tx, input)` 供业务模块复用（避免模块环）。
17. **worker 超时占用释放**（T7-8 配套）：
    - `@wbme/tasks` + `@wbme/approval` 的 `SqlClient` 接口加可选 `transaction<T>(fn)`；`apps/worker/src/sql/pg-client.ts` 用 pool.connect + BEGIN/COMMIT/ROLLBACK 实现。
    - `@wbme/approval/src/timeout.ts`：`AutoCancelHook { onAutoCancel(sql, schema, row, now) }`；`autoCancelOverdueRow` 有 transaction 时把状态迁移 + 动作 + hook 包进同事务（逐行短事务，崩溃即回滚、下轮重试）；`scanAndAutoCancelOverdue` 增 hooks 参数。
    - `apps/worker/src/processors/approval-timeout.asset-release.ts`（新）：释放 SQL——CONSUMABLE_REQUEST/AGENT_REQUEST 减 `inventory_items.reserved_qty`、CONSUMABLE_REQUEST 额度 `quota_occupations RESERVED→RELEASED`、STOCK_CHANGE 减 `reserved_qty`；RETURN/WRITE_OFF/AGENT_SETTLEMENT 为结构 no-op（借还占用是派生值：PENDING 头消失即释放，无需回写）。
    - `approval-timeout.processor.ts` 注册 asset hook + 日志统计。
18. **表格偏好**（T4-12 挂账）：照 hr 三件套补 `modules/base/table-prefs/`（模型 `AssetUserTablePref`，DTO 复用 `table-prefs.dto.ts`），删除 stub。

### 第 4 组：文档与收尾
19. `apps/asset/src/openapi/generate-openapi.ts`（照 hr）+ package.json 加 `openapi:generate`/`openapi:check` 脚本 + 生成 `docs/api-documentations/openapi/asset.openapi.json`。
20. 新建 `docs/api-documentations/asset.md`（结构照 hr.md：通用错误码 → 各功能块 → 表格偏好 → 内部接口）。
21. 更新 `docs/directory.md`（asset 模块登记）、`.agents/plans/实现规划.md`（阶段 7 勾选 + 完成备注，含 T4-12 欠账补全说明）。
22. `app.module.ts` 注册全部业务模块；全仓 `pnpm lint / typecheck / test / build` 转绿。

## 验证

- 每组完成后跑：`pnpm --filter @wbme/asset lint && pnpm --filter @wbme/asset typecheck && pnpm --filter @wbme/asset test`；涉及 contracts/approval/tasks/worker 的改动跑对应包测试。
- 集成测试沿用 hr 模式（真实本地 PostgreSQL，describeDb 无库跳过；beforeAll：ensurePermissionCatalog + 直插 base.users + 打开 backstage.systems ASSET=OPEN + 固定大数段测试 id + 测毕清理还原）。必测验收点：
  - 台账/维修：状态机、调度强制、并发登记维修仅一单成功（条件唯一索引）、批量删除整批拒绝
  - 品种/库位：删除限制、单位锁定、父子循环禁止
  - 库存：账面/占用/可用一致、FIFO 顺序、规格纠正条件
  - 调拨：并发 CONFLICT、总量不变、子批次追溯、幂等重放不重复
  - 申领：整单原子、并发额度仅一单成功、快照持久化、代领不占额度
  - 借还：可申请数量公式、并发不超借出量、回库到原批次
  - 处置：与待审批互斥、恢复账号拒绝、幂等
  - 二维码：作废不可恢复、限流
  - worker hook：fake client 单测 + 真 PG 集成（超时取消后占用释放断言）
- 文档核对：OpenAPI ↔ asset.md ↔ PRD/表设计一致。

## 提交策略

开发完成、全部验证转绿后，**一次主提交**（`feat: 完成阶段7 asset 服务全功能 / Complete stage 7 asset service ...`，与阶段 6 的 ffb717b 风格一致，Conventional Commits 双语标题），随后 `git push`（用户已授权）。如开发中发现必须中途提交的场景（如迁移文件），先向用户说明。
