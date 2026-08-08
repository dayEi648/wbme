# backstage 用户管理 API 文档（阶段3，T3-5）

> 统一前缀 `/api/v1`；错误结构、幂等键、分页遵循主 PRD §9.5。
> 本文档随接口提交同步维护；文档与实现不一致视为任务未完成（实现规划通用任务约定）。
> 批量注销/批量恢复与账号生命周期编排随 T3-5 后半迭代补充；本文已包含 hr 内部接口契约（供 T6-8 实现）。

## 通用约定

- **权限要求**：本组全部接口要求登录态 + 持有"用户管理"功能（`user_manage`）授权或超级管理员
  （`FunctionPermissionGuard`，守卫链语义见 `backstage-permission.md` 通用约定）。
  同命名空间的 M1（激活邀请）/M2（管理员发起密码重置）/M4（解锁账号）已实现于 base 认证模块
  （见 `base-auth.md`「管理操作」节），本轮已切换为同一功能守卫；资料修改审批 X1 同。
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
- 成功：`{ data: [{ id, name, phoneMasked, gender, status, isSuperAdmin, hasDingtalkBinding, createdAt, deactivatedAt }], pagination }`
- 失败：`FORBIDDEN`(403) / `VALIDATION_FAILED`(400)

## U3 用户详情 `GET /users/{id}`

- 成功：单用户展示项（字段同 U2；含已注销账号）
- 失败：`RESOURCE_NOT_FOUND`(404) / `FORBIDDEN`(403)

## U4 编辑基本资料 `PUT /users/{id}`

- 入参：`{ name（≤50）, gender: MALE|FEMALE, idempotencyKey? }`（仅姓名和性别；手机号只读，无修改入口）
- 成功：`{ ok: true }`；失败：`RESOURCE_NOT_FOUND`(404) / `ACCOUNT_DEACTIVATED`(422) /
  `SUPER_ADMIN_TARGET_ONLY`(403) / `VALIDATION_FAILED`(400 无实际变更) / `IDEMPOTENCY_KEY_REUSED`(409)
- 操作日志：UPDATE（含变更前后姓名/性别）

## hr 内部接口契约（账号生命周期恢复，供 T6-8 实现；调用方 platform-core → hr）

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
