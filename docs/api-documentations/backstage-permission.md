# backstage 权限管理 API 文档（阶段3，T3-2）

> 统一前缀 `/api/v1`；错误结构、幂等键、分页遵循主 PRD §9.5。
> 本文档随接口提交同步维护；文档与实现不一致视为任务未完成（实现规划通用任务约定）。
> 功能权限机制（授权目录、数据范围、角色与委派、变更审计）见主 PRD §3.1；界面需求见 backstage PRD §4。

## 通用约定

- **权限要求**：本组全部接口要求登录态 + 持有"权限管理"功能（`permission_manage`）授权或超级管理员
  （`FunctionPermissionGuard`：超管豁免 + 目录存在性过滤，目录中已移除功能的授权行不生效）。
- **委派规则**（主 PRD §3.1，服务层强制）：
  - 操作人不能修改自己的授权（`GRANT_SELF_FORBIDDEN`）；
  - "权限管理"功能仅超级管理员可授予/撤销（`PERMISSION_MANAGEMENT_GRANT_FORBIDDEN`）；
  - 超级管理员账号仅可由超级管理员操作（`SUPER_ADMIN_TARGET_ONLY`）；
  - 权限管理员的可管理范围 = 目录全部普通功能（不含 `permission_manage`）；超管 = 全部功能。
- **目标账号状态**：允许对正常（ACTIVE）与待激活（PENDING_ACTIVATION）账号授权（待激活可提前授权，激活即生效）；
  已注销/已删除账号不可作为目标（单人保存返回 `ACCOUNT_DEACTIVATED`/`RESOURCE_NOT_FOUND`，批量操作逐人阻塞）。
- **幂等**（主 PRD §3.3）：写接口携带可选 `idempotencyKey`；以 backstage 操作日志的
  「操作者 + 系统(BACKSTAGE) + 幂等作用域 + 幂等键」唯一约束为事实，同键同指纹返回原结果，
  同键不同指纹返回 `409 IDEMPOTENCY_KEY_REUSED`；校验失败/事务回滚不留成功记录，修正后可重试。
- **操作日志**：授权变更写入 backstage.operation_logs（feature=`permission_manage`），摘要含变更前后内容；
  批量操作写逐人明细日志 + 一条携带幂等键与结果引用的批次日志。

## P1 员工检索 `GET /permission/employees`

- 入参（query）：`keyword?`（姓名模糊，不区分大小写；含数字时同时匹配手机号片段）、`page?`（默认 1）、`pageSize?`（默认 20，可选 10/20/50/100）
- 范围：正常 + 待激活账号（已注销/已删除不出现）；按 id 升序稳定分页
- 成功：`{ data: [{ id, name, phoneMasked, status, isSuperAdmin, departments, grantsSummary }], pagination { page, pageSize, totalItems, totalPages } }`
  - `departments`：本期恒为 `[]`（hr 组织视图接入后填充真实部门）
  - `grantsSummary`：有效授权摘要（目录过滤后），形如 `固定资产维护（部门）`；超管恒为 `[]`（其豁免由 `isSuperAdmin` 表达）
- 失败：`FORBIDDEN`(403) / `VALIDATION_FAILED`(400)

## P2 查看目标员工当前授权 `GET /permission/employees/{id}/grants`

- 成功：`{ target: { id, name, phoneMasked, status, isSuperAdmin }, permissionVersion, grants: [{ functionCode, dataScope, name, systemCode, sectionCode }] }`
  - `grants` 为目录过滤后的有效授权，按目录排序（系统 → 板块 → 功能）；`permissionVersion` 供 P3 保存时携带
- 失败：`RESOURCE_NOT_FOUND`(404 目标不存在或已删除) / `FORBIDDEN`(403)

## P3 保存单人权限（修改权限）`PUT /permission/employees/{id}/grants`

- 入参：`{ permissionVersion, grants: [{ functionCode, dataScope }], idempotencyKey? }`
  - `grants` 为目标在操作人可管理范围内的**完整功能状态**（空数组 = 清空范围内授权）；功能编码不可重复；
    范围外授权行（非超管操作时的 `permission_manage`）与目录外历史授权行不受影响
- 并发控制：事务内按 `permissionVersion` 条件更新；版本不符返回 `409 GRANT_VERSION_CONFLICT`（"权限已被他人更新"），
  两个携带同一版本的并发保存只有一个成功；成功后目标 `permission_version` 递增（旧授权缓存随之失效）
- 成功：`{ permissionVersion }`（保存后的新版本；幂等重放返回首次结果）
- 失败：`GRANT_SELF_FORBIDDEN`(422) / `SUPER_ADMIN_TARGET_ONLY`(403) / `PERMISSION_MANAGEMENT_GRANT_FORBIDDEN`(422) /
  `FUNCTION_NOT_REGISTERED`(422 目录外功能) / `SCOPE_NOT_SUPPORTED`(422 数据范围不在可选档位) /
  `ACCOUNT_DEACTIVATED`(422) / `RESOURCE_NOT_FOUND`(404) / `IDEMPOTENCY_KEY_REUSED`(409) / `VALIDATION_FAILED`(400)
- 操作日志：UPDATE，摘要含变更前后授权列表

## P4 批量授权（增量）`POST /permission/grants/batch`

- 入参：`{ userIds: number[]（≤100 且不重复）, grants: [{ functionCode, dataScope }], groupIds?: number[], idempotencyKey? }`
  - `groupIds` 为权限组展开预留入参（T3-3 实现展开；本期传非空返回 `VALIDATION_FAILED`）
- 语义：为所选员工**追加**授权（已持有的功能+档位自动跳过），不改动已有授权；
  先整批校验（存在性/账号状态/自我修改/超管保护），任一目标失败则整批回滚，**不产生任何写入**；
  全部通过后单事务完成：用户行锁（按 id 有序）串行化 + 逐人递增版本 + 逐人操作日志；
  批量场景不携带目标授权版本（列表多选无版本上下文），并发安全由行锁与版本递增保证
- 成功：`{ ok: true, userIds }`（幂等重放返回原结果，不重复产生授权/版本递增/日志）
- 失败：`GRANT_BATCH_BLOCKED`(422，`details.failures: [{ userId, code, message }]`，code ∈
  `TARGET_NOT_FOUND / TARGET_DEACTIVATED / SELF_MODIFICATION / SUPER_ADMIN_TARGET`) /
  授权项非法同 P3 / `IDEMPOTENCY_KEY_REUSED`(409) / `VALIDATION_FAILED`(400 空数组/超上限/重复标识)
- 操作日志：CREATE；逐人明细 + 批次汇总（含幂等键）

## P5 批量撤销 `POST /permission/revocations/batch`

- 入参：`{ userIds: number[]（≤100 且不重复）, idempotencyKey? }`（二次确认由前端负责）
- 语义：撤销所选员工在操作人可管理范围内的**全部**功能授权；范围外与目录外授权行不受影响；
  范围内无授权的目标跳过（不递增版本、不写日志）；整批语义与 P4 一致
- 成功/失败/日志：同 P4（actionType=DELETE）
