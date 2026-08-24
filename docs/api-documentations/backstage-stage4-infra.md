# Backstage Stage 4 基础设施 API

> 覆盖系统设置、操作日志查询、系统日志（错误/安全）。  
> 基础路径：`/api/v1`；除个人中心外均需登录会话。

## 1. 系统设置

**权限**：`system_settings`（管理后台 → 系统 → 系统设置）

### GET `/system-settings`

列出全部平台设置项。

**响应示例**：

```json
{
  "settings": [
    {
      "key": "query.default.window.days",
      "label": "默认查询时间窗口（天）",
      "value": 30,
      "defaultValue": 30,
      "min": 1,
      "max": 365
    }
  ]
}
```

**平台设置键**：

| 键 | 默认值 | 边界 |
| --- | --- | --- |
| `session.idle.timeout.seconds` | 86400 | 60～2592000 |
| `session.idle.remember.seconds` | 2592000 | 60～15552000 |
| `session.abs.timeout.seconds` | 604800 | 60～7776000 |
| `session.abs.remember.seconds` | 7776000 | 60～31536000 |
| `login.account.max.attempts` | 10 | 1～100 |
| `login.account.lock.seconds` | 600 | 60～86400 |
| `login.ip.window.seconds` | 3600 | 60～86400 |
| `login.ip.max.attempts` | 120 | 1～10000 |
| `login.ip.lock.seconds` | 3600 | 60～86400 |
| `invitation.valid.seconds` | 604800 | 60～7776000 |
| `query.default.window.days` | 30 | 1～365 |
| `export.max.rows` | 100000 | 1～200000 |
| `backup.retention.days` | 30 | 7～365 |
| `upload.unassociated.image.retention.hours` | 24 | 1～168 |
| `approval.timeout.cancel.days` | 30 | 1～365 |

> 会话/登录保护/邀请有效期键对应 base PRD §2/§3/§4「可在系统设置中调整」；API 中仍以秒存储和传输，但这些时长只接受整分钟值。管理界面统一以分钟编辑；前端设置页书签化见批次 4。

### PUT `/system-settings`

批量更新平台设置（支持幂等键）。

**请求体**：

```json
{
  "idempotencyKey": "optional-client-key",
  "patches": {
    "query.default.window.days": 60,
    "export.max.rows": 150000
  }
}
```

**行为**：校验边界和整数单位、确保空闲超时不大于对应的绝对过期 → 写入 `backstage.system_settings` → 失效进程内缓存 → Redis `config:broadcast` 广播 → 记录操作日志。

### GET `/system-settings/dingtalk-import`

返回钉钉员工导入配置状态，不返回 AppKey、AppSecret、CorpId 或默认密码明文。

**响应**：`{ appKeyConfigured, appSecretConfigured, corpIdConfigured, defaultPasswordConfigured, ready }`

### PUT `/system-settings/dingtalk-import`

更新钉钉员工导入设置（支持幂等键）；空字段保持已保存值。请求体为
`{ appKey?, appSecret?, corpId?, defaultPassword?, idempotencyKey? }`。响应仅返回上述配置状态，不回显 AppSecret 或默认密码；默认密码长度为 8～32 位。

---

## 2. 操作日志

**权限**：`operation_log_view`（数据范围：部门/公司）

### GET `/operation-logs`

分页查询全员操作日志（经 `backstage.operation_logs_union` 视图）。

**查询参数**：

| 参数 | 说明 |
| --- | --- |
| `page` / `pageSize` | 分页（默认 1/20，最大 100） |
| `system` | 所属系统 |
| `feature` | 功能编码 |
| `operatorId` | 操作人 id |
| `departmentId` | 部门 id（含下级部门，按操作者操作时部门快照 `operatorDepartments` 与 `hr.department_closure` 闭包交集过滤） |
| `actionType` | `CREATE` / `UPDATE` / `DELETE` / `EXPORT` |
| `from` / `to` | 时间范围 |

**响应字段**（不含幂等键、指纹、结果引用）：

`id`, `operatorId`, `operatorName`, `operatorDepartments`, `system`, `feature`, `actionType`, `summary`, `requestId`, `createdAt`

**数据范围**：

- `COMPANY`：全公司可见
- `DEPARTMENT`：按 `operator_departments` 与 `hr.department_closure` 闭包交集过滤

### GET `/operation-logs/department-options`

部门筛选树选项（扁平 `parentId` 列表，前端组装树）。经 `hr.departments_view` 只读视图读取（直接父级由 `hr.department_closure` 按深度差推导），hr 容器停止不影响查询页加载。

**响应**：`{ data: [{ id, name, parentId, status }] }`

**数据范围**：`COMPANY` 返回全部部门；`DEPARTMENT` 裁剪为本人部门闭包及其祖先链（保证树可组装）。

### GET `/me/operation-logs`

个人中心「我的操作日志」（全员可用，仅本人记录）。参数：`page`, `pageSize`。

---

## 3. 系统日志

**权限**：`system_log_view`

### GET `/system-logs/errors`

错误日志列表（默认按 `lastSeenAt` 倒序）。

**查询参数**：`page`, `pageSize`, `level`, `service`, `source`, `errorCategory`, `fingerprint`, `status`（`PENDING`/`HANDLED`/`IGNORED`）, `from`, `to`

### GET `/system-logs/errors/:id`

错误日志详情（含脱敏 `sample`、首尾 `requestId`）。

### POST `/system-logs/errors/:id/dispose`

处置错误日志（`PENDING` → `HANDLED` / `IGNORED`，单向流转）。

**请求体**：

```json
{
  "status": "HANDLED",
  "remark": "可选备注"
}
```

并发处置第二个请求返回 `409 CONFLICT`。

### GET `/system-logs/security`

安全日志列表（按 `id` 倒序）。

**查询参数**：`page`, `pageSize`, `eventType`, `actorId`, `targetUserId`, `result`, `from`, `to`

### POST `/system-logs/errors/export` / `/system-logs/security/export`

导出为 xlsx（通用导出：行数上限、单用户并发互斥、120s 超时、一致性快照）。错误日志导出按 backstage PRD §8 白名单构造「安全摘要」列（剥离堆栈/内部路径/requestId，仅含脱敏后的 message 首行）；安全日志导出含来源 IP，其余字段白名单。

---

## 4. 共享日志写入（`@wbme/logging`）

各部署单元通过 `RawSqlClient` 调用受限语句：

- `upsertErrorLog` — 五分钟聚合写入 `backstage.error_logs`
- `insertSecurityLog` — 追加 `backstage.security_logs`
- `formatOperationSummary` — 操作日志摘要模板

`platform-core` 在 `GlobalExceptionFilter` 中对 SYSTEM/DEPENDENCY 未知异常 fire-and-forget 调用 `upsertErrorLog`。
