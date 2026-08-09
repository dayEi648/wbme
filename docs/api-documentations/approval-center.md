# 统一审批中心 API 文档（阶段5）

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

门户 `GET /portal` 的 `badgeCount` = 本地可见资料修改待办 + 内部拉取 hr/asset `pending-count` 之和（依赖不可用贡献 0）。

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
| `OVERTIME` | 允许多条；时段重叠校验见 T6-5 |

- 批准/驳回业务副作用（组织变更、加班落账）本期为 no-op，T6-5/T6-6 接入
- 部门范围闭包过滤本期简化（T6 补齐）；公司范围与类型授权过滤已生效

### 内部接口

`GET /internal/v1/approval-requests/pending-count?userId=`

- 调用方：`platform-core`（内部令牌 + 白名单）
- 响应：`{ total, byType }`，口径与审批中心一致

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

- 批准/驳回库存副作用本期为 no-op，T7-6～T7-8 接入
- 「注销员工借还处置」非审批类型，见 T7-9，不在本中心待办

### 内部接口

同 hr：`GET /internal/v1/approval-requests/pending-count?userId=`

---

## 超时自动取消

- 系统设置：`approval.timeout.cancel.days`（默认 30，1～365）
- Worker 每日调度 `APPROVAL_TIMEOUT_SCAN`（北京时间 04:00 后）扫描 `backstage` / `hr` / `asset`
- 超时 PENDING → `CANCELLED` + `cancel_source=OVERDUE` + `AUTO_CANCEL` 动作流水
- 审批头不保存 `expiresAt`
