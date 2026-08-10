# 统一审批中心 API 文档

> 统一前缀 `/api/v1`（内部接口 `/internal/v1`）；错误结构、幂等键、分页遵循主 PRD §9.5。
> 共享内核：`@wbme/approval`（状态机、版本条件更新、范围校验、待审批限制、超时扫描）。
> 各部署单元自有 `approval_requests` / `approval_actions`，无中央审批服务。

## 通用契约

### 状态机（主 PRD §3.2）

- 状态：`DRAFT` → `PENDING` → `APPROVED` | `REJECTED` | `CANCELLED`（终态不可回退）
- 处理：`status + version` 条件更新；并发仅一个成功，其余 `STATUS_CONFLICT`(409)
- 驳回必须填写 `opinion`，否则 `REJECT_REASON_REQUIRED`(400)
- 取消来源：`USER` / `ACCOUNT_DEACTIVATED` / `OVERDUE`（超时扫描 `AUTO_CANCEL`）
- 范围外记录对调用者表现为不存在（404），不返回 403 泄露存在性

### 公共错误码（APPROVAL 域）

| code | HTTP | 说明 |
| --- | --- | --- |
| `STATUS_CONFLICT` | 409 | 状态/版本并发冲突 |
| `SCOPE_NOT_COVERED` | 422 | 数据范围未覆盖全部对象 |
| `PENDING_LIMIT_REACHED` | 409 | 同业务键已有待审批 |
| `STATUS_NOT_ALLOWED` | 422 | 当前状态不允许该操作 |
| `REJECT_REASON_REQUIRED` | 400 | 驳回须填原因 |
| `APPLICANT_DEACTIVATED` | 422 | 账号已注销（资料型） |

资料修改二次提交仍可返回 `PROFILE_CHANGE_PENDING_EXISTS`(ACCOUNT 域，兼容既有契约)。

### 公共列表查询

`GET /approval-requests`

| 参数 | 说明 |
| --- | --- |
| `page` / `pageSize` | 分页（默认 20，最大 100） |
| `requestType` | 申请类型筛选 |
| `status` | `PENDING` / `PROCESSED` / 具体状态 |
| `keyword` | 申请编号/姓名模糊 |
| `applicantName` / `processorName` | 姓名筛选 |

### 公共写接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/approval-requests/{id}/process` | `{ action: APPROVE\|REJECT, opinion?, idempotencyKey? }` |
| `POST` | `/approval-requests/{id}/cancel` | 申请人或代交人取消；`cancelSource=USER` |
| `GET` | `/approval-requests/pending-count` | `{ total, byType }` 当前用户可见 PENDING |
| `GET` | `/approval-requests/{id}` | 详情 + 明细 + actions 时间线 |

---

## platform-core（backstage）

**权限**：`user_manage`（公司范围）→ `PROFILE_CHANGE`；取消接口仅需登录且操作人为申请人。

| 类型 | 待审批限制 |
| --- | --- |
| `PROFILE_CHANGE` | 同一 `applicant_id` 最多一条 PENDING（条件唯一索引） |

- 批准：同事务更新 `base.users` 姓名/性别
- 注销：账号资料型，批量注销时 `cancelSource=ACCOUNT_DEACTIVATED` 自动取消
- 提交：写 `SUBMIT` 动作流水

门户 `GET /portal` 的 `badgeBySystem` = 按系统拆分角标（M24）：`BACKSTAGE`（本地可见资料修改待办）、`HR`/`ASSET`（内部拉取 `pending-count`，依赖不可用贡献 0）、`FIN`（无审批待办恒 0）。

---

## hr

**权限映射**

| 功能 | 类型 |
| --- | --- |
| `overtime_approval`（部门/公司） | `OVERTIME` |
| `org_structure`（公司） | `POSITION_CHANGE` |

| 类型 | 待审批限制 |
| --- | --- |
| `POSITION_CHANGE` | 同一 `applicant_id` 最多一条 PENDING |
| `OVERTIME` | 允许多条；时段重叠校验见 hr.md |

- 数据范围：`overtime_approval` DEPARTMENT 档按审批人部门闭包（hr.department_closure 视图，
  含下级、多部门并集）过滤可见待办/详情/统计；批次对象=加班明细提交时部门快照，快照中
  任一部门不在闭包内则该批次不可见；处理接口范围未覆盖 → `SCOPE_NOT_COVERED`(422)。
- 批准副作用：`POSITION_CHANGE` 批准时事务内重校验（员工仍无/单部门、目标部门有效、
  目标岗位有效且允许自助申请且适用）→ 组织生效 + `user_org_version++`；任一条件不成立
  → `POSITION_APPLY_STALE`(422) 保持待审批；`OVERTIME` 批准无副作用。
- 审批中心导出：`POST /api/v1/approval-requests/export`（查询参数与列表同构；runExport 流式；
  行数上限=平台设置 export.max.rows；导出完成写 EXPORT 操作日志）。

### 内部接口

`GET /internal/v1/approval-requests/pending-count?userId=`

- 调用方：`platform-core`（内部令牌 + 白名单）
- 响应：`{ total, byType }`，口径与审批中心一致（DEPARTMENT 档按闭包裁剪）

---

## asset

**权限**：`consumable_approval`

| 数据范围 | 可见类型 |
| --- | --- |
| 公司 | 全部：`STOCK_IN` / `STOCK_CHANGE` / `CONSUMABLE_REQUEST` / `AGENT_REQUEST` / `RETURN` / `WRITE_OFF` / `AGENT_SETTLEMENT` |
| 部门 | 排除 `STOCK_IN` / `STOCK_CHANGE`（主 PRD §3.2 例外） |

| 类型 | 待审批限制 |
| --- | --- |
| `AGENT_SETTLEMENT` | 同一 `ref_request_id` 最多一条 PENDING |
| 其余 | 允许多条（库存/额度约束见 T7） |

- T7：DEPARTMENT 档按部门闭包裁剪（申请人/受领人名单/借出时部门快照全部 ∈ 闭包，快照形状兼容数组与单对象）；批准/驳回/取消业务副作用与终态同一事务（入库建批次、变更/申领 FIFO 出库与额度转换、归还回库、核销、代领结清；驳回/取消释放占用）
- 审批中心导出：`GET /approval-requests/export/all`（runExport，可见性与列表一致）
- 我的申请：`GET /approval-requests/mine` 仅返回当前申请人或代交人的资产审批历史，不要求
  `consumable_approval`；待审批项仍通过 `POST /approval-requests/{id}/cancel` 由申请人/代交人取消。
- 「注销员工借还处置」非审批类型（`GET/POST /disposals`），见 asset.md，不在本中心待办

### 内部接口

同 hr：`GET /internal/v1/approval-requests/pending-count?userId=`

---

## 超时自动取消

- 系统设置：`approval.timeout.cancel.days`（默认 30，1～365）
- Worker 每日调度 `APPROVAL_TIMEOUT_SCAN`（北京时间 04:00 后）扫描 `backstage` / `hr` / `asset`
- 超时 PENDING → `CANCELLED` + `cancel_source=OVERDUE` + `AUTO_CANCEL` 动作流水
- 审批头不保存 `expiresAt`
