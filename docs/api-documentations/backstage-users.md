# backstage 用户管理 API 文档

> 统一前缀 `/api/v1`；错误结构、幂等键、分页遵循主 PRD §9.5。
> 本文档随接口提交同步维护；文档与实现不一致视为任务未完成（实现规划通用任务约定）。
> 本文含批量注销/恢复（账号生命周期编排）与 hr 内部接口契约。

## 通用约定

- **权限要求**：本组全部接口要求登录态 + 持有"用户管理"功能（`user_manage`）授权或超级管理员
  （`FunctionPermissionGuard`，守卫链语义见 `backstage-permission.md` 通用约定）。
  同命名空间的 M1（激活邀请）/M2（管理员发起密码重置）/M4（解锁账号）实现于 base 认证模块
  （见 `base-auth.md`「管理操作」节），与资料修改审批 X1 共用同一功能守卫。
- **超管目标保护**：超级管理员账号仅可由超级管理员管理（`SUPER_ADMIN_TARGET_ONLY` 403）——
  普通"用户管理"持有者不能编辑/重置/解锁/注销/恢复超管账号，也不能改变其站点角色。
- **幂等与日志**：写接口携带可选 `idempotencyKey`（语义见主 PRD §3.3）；操作日志写
  backstage.operation_logs（feature=`user_manage`），含变更前后内容。
- **目标状态**：已注销账号不可编辑（`ACCOUNT_DEACTIVATED`，先恢复）；待激活账号无密码，
  不显示重置密码操作（M2 仅 ACTIVE 可用，M1 仅待激活可用——base 既有校验）。

## U1 创建用户 `POST /users`

- 入参：`{ name（≤50）, phone, gender: MALE|FEMALE, idempotencyKey? }`
- 语义：创建**待激活**基础账号（无密码、未绑定钉钉）；手机号入库前规范化为 `+CC` 格式，
  在待激活与正常账号间唯一（部分唯一索引兜底）；激活时以钉钉返回为准（base PRD §2）
- 成功：`{ id, status: 'PENDING_ACTIVATION' }`（幂等重放返回首次创建结果；激活邀请走 M1）
- 失败：`PHONE_TAKEN`(422 手机号被待激活/正常账号占用) / `VALIDATION_FAILED`(400 手机号无法规范化、姓名为空) /
  `FORBIDDEN`(403) / `IDEMPOTENCY_KEY_REUSED`(409)
- 操作日志：CREATE

## U2 用户列表 `GET /users`

- 入参（query）：`status?`（`PENDING_ACTIVATION / ACTIVE / DEACTIVATED`；缺省 = 未注销全部——
  已注销列表为主 PRD §2.6 默认过滤的管理专用例外）、`keyword?`（姓名模糊；含数字同时匹配手机号片段）、`page?`、`pageSize?`
- 成功：`{ data: [{ id, name, phone, gender, status, isSuperAdmin, hasDingtalkBinding, createdAt, deactivatedAt }], pagination }`
- 失败：`FORBIDDEN`(403) / `VALIDATION_FAILED`(400)

## U3 用户详情 `GET /users/{id}`

- 成功：单用户展示项（字段同 U2；含已注销账号）
- 失败：`RESOURCE_NOT_FOUND`(404) / `FORBIDDEN`(403)

## U2.1 钉钉导入候选 `GET /users/dingtalk-import/candidates`

- 入参（query）：`snapshotId?`（首次省略；后续分页/搜索回传）、`refresh?`（`true` 强制更新通讯录快照）、`keyword?`（姓名或手机号）、`page?`、`pageSize?`
- 成功：`{ snapshotId, data: [{ unionId, name, phone, importable, disabledReason? }], pagination }`。`phone` 为完整手机号；`importable=false` 的行不可勾选，原因包括平台手机号已使用、钉钉 ID 已绑定、离职、资料无效或通讯录内手机号重复。
- 语义：按当前操作人隔离的五分钟通讯录快照服务端搜索与分页；首次打开及刷新会从钉钉组织架构重新读取当前应用获授范围。
- 失败：`DINGTALK_IMPORT_CONFIG_MISSING`(503) / `DINGTALK_UNAVAILABLE`(503) / `FORBIDDEN`(403) / `RATE_LIMITED`(429)

## U2.2 确认钉钉导入 `POST /users/dingtalk-import`

- 入参：`{ snapshotId: uuid, unionIds: string[]（1～100）, idempotencyKey? }`；客户端不得提交或信任姓名、手机号。
- 语义：服务端重新读取钉钉组织架构，并在单事务内复查所有手机号和钉钉 ID 占用；任一目标不可导入时整批零写入。成功时逐人创建 `ACTIVE` 账号、写入默认密码的 Argon2 摘要、默认性别 `MALE`、建立 `BOUND` 钉钉绑定并写安全日志。
- 成功：`{ userIds, importedCount }`（幂等重放返回首次结果）
- 失败：`USER_BATCH_BLOCKED`(422，`details.failures` 含逐人原因) / `CONFLICT`(409，快照已过期) / `DINGTALK_IMPORT_CONFIG_MISSING`(503) / `DINGTALK_UNAVAILABLE`(503) / `FORBIDDEN`(403) / `IDEMPOTENCY_KEY_REUSED`(409)

## U4 编辑基本资料 `PUT /users/{id}`

- 入参：`{ name（≤50）, gender: MALE|FEMALE, idempotencyKey? }`（仅姓名和性别；手机号只读，无修改入口）
- 成功：`{ ok: true }`；失败：`RESOURCE_NOT_FOUND`(404) / `ACCOUNT_DEACTIVATED`(422) /
  `SUPER_ADMIN_TARGET_ONLY`(403) / `VALIDATION_FAILED`(400 无实际变更) / `IDEMPOTENCY_KEY_REUSED`(409)
- 操作日志：UPDATE（含变更前后姓名/性别）

## U5 批量注销 `POST /users/deactivations/batch`

- 入参：`{ userIds: number[]（≤100 且不重复）, idempotencyKey? }`（仅批量入口，无单个注销；二次确认由前端负责）
- 前置校验（任一失败整批回滚、零写入，`USER_BATCH_BLOCKED` 422，`details.failures: [{ userId, code, message }]`）：
  `TARGET_NOT_FOUND / TARGET_DEACTIVATED / SELF_MODIFICATION（不能注销自己）/ SUPER_ADMIN_TARGET / LAST_SUPER_ADMIN（批内含全部可用超管）`
- 单一本地事务三件套（backstage PRD §3）：
  ① base 注销：`status=DEACTIVATED` + 注销时间/操作人 + `session_version` 递增（全部会话下次请求即失效）
    + `lifecycle_version` 递增 + 目标全部未使用邀请立即失效；
  ② 取消该批用户全部待审批资料修改申请（账号资料型，`cancel_source=ACCOUNT_DEACTIVATED`；
    加班/库存等业务型待审批记录不受影响，审批接口不得因申请人已注销拒绝处理）；
  ③ 每名用户一条"账号生命周期处理"任务（`PENDING_ENQUEUE`，`task_uuid` 由稳定业务键
    `ACCOUNT_LIFECYCLE:DEACTIVATED:{userId}:{lifecycleVersion}` 派生，ref 含 userId/deactivatedAt/lifecycleVersion；
    hr 下线不阻塞注销，恢复后继续消费）。
- 成功：`{ ok: true, userIds }`（幂等重放返回原结果，不重复建任务/日志）
- 操作日志：DELETE；逐人明细 + 批次汇总（含幂等键）

## U6 恢复预览 `POST /users/restorations/preview`

- 入参：`{ userIds: number[]（≤100 且不重复） }`
- 语义：实际调用 hr `restore-preview` 内部接口（就绪检查——hr 停止/未就绪/超时/无效响应 →
  `HR_SERVICE_UNAVAILABLE` 503，零变更）；返回逐目标差异供确认页展示
- 成功：`{ restoreRequestId: uuid, items: [{ userId, name, phone, lifecycleVersion, restoreStatus,
  restorable, blockedReason?, revokedGrants: [{ functionCode, dataScope, name }], removedDepartmentNames?, positionCleared? }] }`
  - `blockedReason`（本地侧）：`TARGET_NOT_FOUND / TARGET_NOT_DEACTIVATED / SUPER_ADMIN_TARGET / PHONE_OCCUPIED`
    （手机号被其他待激活/正常账号占用，待占用解除后重试）；hr 侧原因码原样透传
  - `revokedGrants`：恢复时将被移除的授权（目录未注册或数据范围失效）；`restoreStatus`：待激活恢复后仍待激活
- 失败：`HR_SERVICE_UNAVAILABLE`(503) / `FORBIDDEN`(403)

## U7 恢复确认 `POST /users/restorations/confirm`

- 入参：`{ restoreRequestId: uuid（预览返回的稳定恢复请求 ID）, targets: [{ userId, lifecycleVersion }], idempotencyKey? }`
- 两阶段安全顺序（backstage PRD §3）：本地预校验（存在/已注销/版本匹配/超管目标/手机号占用，
  任一失败 `USER_BATCH_BLOCKED` 且不调 hr、零变更）→ **hr 整批幂等应用**（同 restoreRequestId 重试返回原结果；
  hr 4xx 整批拒绝 → `CONFLICT` 409，请重新预览）→ 本地事务：行锁 + 逐目标版本条件复核
  （漂移 → `CONFLICT`，hr 已成功时同 ID 重试完成本地恢复）→ 清除注销标记、写恢复人/时间、
  `lifecycle_version`/`permission_version` 递增、权限兼容性清理（失效授权物理删除、明细入日志）。
  不创建新账号、旧会话不恢复（用户需重新登录）
- 成功：`{ ok: true, userIds }`（幂等重放返回原结果，不再调 hr）
- 操作日志：UPDATE；逐人明细（含被移除授权）+ 批次汇总（含恢复请求 ID 引用）

## S1 任命超级管理员 `POST /users/{id}/super-admin`

- 入参：`{ idempotencyKey? }`（单对象操作；二次确认由前端负责）
- 规则（主 PRD §3.1）：**仅超级管理员可操作**（不拆成可委派功能，非超管 `403 FORBIDDEN`）；
  事务内复核操作人当前仍是超管、目标账号状态与约束；仅正常（ACTIVE）普通员工可被任命——
  待激活账号激活后即为普通员工再由超管任命（`USER_NOT_ACTIVE`），已注销 `ACCOUNT_DEACTIVATED`，
  已是超管 `ALREADY_SUPER_ADMIN`
- 提权旋转（base PRD §3）：任命 = 站点角色提升，提交后标记目标会话旋转（下次请求透明轮换标识）；
  目标 `permission_version` 递增
- 成功：`{ ok: true }`（幂等重放返回首次结果）；操作日志 UPDATE（摘要含"站点角色 员工 → 超级管理员"前后值）

## S2 超级管理员降级 `DELETE /users/{id}/super-admin`

- 入参：`{ idempotencyKey? }`（请求体）；把超管降级为普通员工，可对自己操作
- 规则：仅超管可操作；`NOT_SUPER_ADMIN`(422 目标不是超管)；**最后一名可用超管**（ACTIVE 且未注销）
  不可卸任/降级 → `LAST_SUPER_ADMIN`(422)；并发卸任以"锁定全部可用超管行"串行化，恰一个成功
- 降级不是提权，**不旋转会话**（即时生效由守卫实时读取站点角色保证）；目标 `permission_version` 递增
- 成功：`{ ok: true }`；操作日志 UPDATE（前后值）

## hr 内部接口契约（账号生命周期恢复；调用方 platform-core → hr）

> 前缀 `/internal/v1`（内部令牌 + 调用方白名单，主 PRD §9.4）。恢复预览与最终确认都必须实际调用 hr
> （产品状态检查不能代替服务就绪）；hr 停止/未就绪/超时/返回无效响应时，调用方统一返回
> `DEPENDENCY + HR_SERVICE_UNAVAILABLE`(503 "人事系统当前不可用，无法恢复用户")，任何账号不发生变更。
> 两接口均以 `restoreRequestId` 幂等：同 ID 重试返回原结果；携带幂等键，允许有界重试。

### `POST /internal/v1/lifecycle/restore-preview`（恢复兼容性预览，组织侧）

- 请求：`{ restoreRequestId: uuid, targets: [{ userId, deactivatedAt(ISO8601), lifecycleVersion }] }`
- 响应 200：`{ targets: [{ userId, restorable, blockedReasonCode?, removedDepartmentNames?: string[], positionCleared?: boolean }] }`
  - hr 兼容性规则（backstage PRD §3）：只保留仍存在且可用的部门关系（无有效部门则置空）；
    岗位不存在或不再适用于全部保留部门时岗位置空；若注销时的生命周期任务尚未消费，
    须在恢复应用事务中先幂等取消注销时间之前提交且仍待审批的岗位申请。

### `POST /internal/v1/lifecycle/restore-apply`（幂等恢复应用，整批全有或全无）

- 请求：同 preview（`restoreRequestId` 为稳定恢复请求 ID）
- 响应 200：`{ applied: true }`（hr 在自己的单个数据库事务中重新校验全部目标并应用整批组织兼容性清理；
  同 restoreRequestId 重放返回原结果——platform-core 本地事务失败后的重试依赖此语义，不要求人工补偿）
- 4xx：整批拒绝（任一目标已变化/不可处理），platform-core 不恢复任何账号（调用方映射为 CONFLICT，操作者重新预览）；
  5xx/超时/连接失败/无效响应：`HR_SERVICE_UNAVAILABLE`
