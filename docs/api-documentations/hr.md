# hr 服务 API 文档（阶段6）

> 统一前缀 `/api/v1`（内部接口 `/internal/v1`）；错误结构、幂等键、分页遵循主 PRD §9.5。
> 权限：所有业务路由经全局会话守卫；功能授权在服务内断言（未注册/未授权 → 404 不泄露存在性，
> 系统未开放 → `SYSTEM_NOT_OPEN`(503)）。
> 数据范围：`DEPARTMENT` 档按当前用户部门闭包（hr.department_closure 视图：部门及全部下级、
> 多部门并集）过滤；`COMPANY` 档全量。
> 组织版本：用户组织关系变更递增 `user_org_version`、部门树结构变更递增 `org_tree_version`
> （H-1 org_meta，供 base PRD §3 守卫缓存校验）。

## 通用错误码（HR 域）

| code | HTTP | 说明 |
| --- | --- | --- |
| `OVERTIME_OVERLAP` | 422 | 加班时间段与已有待审批/已批准记录重叠 |
| `OVERTIME_DATE_OUT_OF_WINDOW` | 422 | 加班日期超出提前申请/补交窗口 |
| `OVERTIME_BATCH_REJECTED` | 422 | 批次存在校验未通过人员（details.failures 逐人原因，零写入） |
| `OVERTIME_EMPLOYEE_NOT_ACTIVE` | 422 | 加班员工账号状态异常（逐人原因） |
| `MULTI_DEPARTMENT_APPLY_FORBIDDEN` | 422 | 多部门员工不能通过个人中心变更组织关系 |
| `POSITION_DEPARTMENT_MISMATCH` | 422 | 岗位不适用于所选部门的全部归属关系 |
| `POSITION_APPLY_TARGET_UNAVAILABLE` | 422 | 目标部门或岗位当前不可申请 |
| `POSITION_APPLY_STALE` | 422 | 申请条件已变化，当前不可批准（保持待审批） |
| `DEPARTMENT_HAS_CHILDREN` | 422 | 部门存在未删除下级，禁止删除 |
| `ORGANIZATION_CYCLE` | 422 | 组织关系不能形成循环 |
| `ORGANIZATION_VERSION_CONFLICT` | 409 | 组织架构已变化，请刷新后重试（预留：版本冲突守卫随授权缓存接入时启用，当前无返回路径） |
| `RESTORE_TARGET_STALE` | 409 | 恢复目标已变化，请重新预览 |

依赖错误：节假日判断失败且离线未覆盖 → `HOLIDAY_API_UNAVAILABLE`(503 DEPENDENCY)。

---

## 组织架构（hr PRD §5）

权限：`org_structure`（公司档）；部门树查看另可用 `department_manage` 任一。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/org/employees` | 全体员工列表（keyword/departmentId/positionId 筛选 + 分页；含部门/岗位/职称派生——职称经 hr.user_titles 视图实时计算） |
| `PUT` | `/org/employees/{userId}/departments` | 调整员工所属部门（多部门并列；岗位须适用于全部新部门，否则 `POSITION_DEPARTMENT_MISMATCH`；`user_org_version++`） |
| `PUT` | `/org/employees/{userId}/position` | 调整员工岗位（单岗位；须启用且适用于全部当前部门） |

## 部门管理（hr PRD §6）

权限：`department_manage`（公司档）。配置类数据按主 PRD §2.6 确认式硬删除。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/departments/tree` | 部门树（含负责人/状态；`org_structure` 或 `department_manage` 任一可见） |
| `POST` | `/departments` | 创建部门（幂等；停用部门不能作为新建下级目标；`org_tree_version++`） |
| `PUT` | `/departments/{id}` | 更新部门（名称/排序/启停） |
| `PUT` | `/departments/{id}/move` | 移动部门节点（环校验 `ORGANIZATION_CYCLE`；页面展示受影响子树并二次确认） |
| `GET` | `/departments/delete-preview?ids=` | 删除前引用确认（在职员工数/资产数[阶段7接入，当前0占位]/待审批申请数/职称规则引用数） |
| `DELETE` | `/departments/delete` | 批量硬删除（有未删除下级整批不变更；同一事务清理员工/负责人/岗位适用引用；`org_tree_version++`） |

## 岗位管理（hr PRD §7）

权限：`position_manage`（公司档）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/positions` | 岗位列表（含适用部门；`includeDisabled=true` 含停用） |
| `POST` | `/positions` | 创建岗位（幂等；岗位名唯一；可带 departmentIds） |
| `PUT` | `/positions/{id}` | 更新岗位（名称/说明/启停/排序/是否允许自助申请） |
| `PUT` | `/positions/{id}/departments` | 更新适用部门（修改前校验全部在岗员工兼容性，不兼容整次拒绝并返回 affectedUserIds） |
| `GET` | `/positions/delete-preview?ids=` | 删除前引用确认（在岗员工数/待审批岗位申请数/职称规则引用数） |
| `DELETE` | `/positions/delete` | 批量硬删除（在岗员工岗位置空；待审批申请保留但批准时失败） |

## 职称管理（hr PRD §8）

权限：`title_manage`（公司档）。当前职称是派生值（hr.user_titles 视图），无独立查询接口——组织架构员工列表已含职称列。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/title-rules` | 规则列表（分页；keyword/status 筛选；软删排除） |
| `POST` | `/title-rules` | 创建规则（幂等；条件目标须存在；条件可部分填写，全空=通用规则） |
| `PUT` | `/title-rules/{id}` | 更新规则 |
| `DELETE` | `/title-rules/delete` | 批量软删除（不提供硬删除；软删不参与匹配） |

## 节假日（hr PRD §3）

日期判断统一经后端节假日适配器（前端不直连第三方）：
免费 API `https://holiday.ailcc.com`（白名单，受版本控制）+ 24h 集成缓存（hr.holiday_results UPSERT）
+ 并发合并 + 进程级有界限流 + 严格响应校验（SHA-256 摘要）+ 版本控制离线兜底数据
（offline-holiday-2026.json，国办发明电〔2025〕7号）；已提交加班使用提交时快照，不追溯改写。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/overtime/date-type?date=YYYY-MM-DD` | 提交前日期类型/时长/补交提示的前置契约（hr PRD §3）；返回 `{ date, dateType, weekday, source, digest, fetchedAt }`；缓存与离线均未覆盖时 `HOLIDAY_API_UNAVAILABLE`(503 DEPENDENCY) |

## 加班（hr PRD §3）

权限：提交 `overtime_apply`（SELF，名单固定本人）或 `proxy_overtime`（部门/公司档）任一；
管理视图 `overtime_history`（部门/公司档）；个人视图隐含本人历史（无需额外授权）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/overtime/applications` | 提交加班批次（幂等；`OvertimeSubmitDto`：overtimeDate YYYY-MM-DD、startMinute 0-1439、endMinute 1-1440（24:00=1440）、reason≤500、userIds 1~100 去重；全有或全无——任一失败 `OVERTIME_BATCH_REJECTED` + 逐人原因，零写入；日期窗口=人事配置提前申请/补交窗口；节假日快照随明细保存） |
| `POST` | `/overtime/applications/{id}/cancel` | 取消本人/代提待审批批次（批准或驳回后不能取消） |
| `GET` | `/overtime/mine` | 个人已批准记录（month 筛选 + 分页；含日期类型/时长） |
| `GET` | `/overtime/mine/summary` | 个人月度汇总（分钟精度；小时=分钟÷60 两位小数） |
| `GET` | `/overtime/records` | 管理视图：员工列表 + 月度统计（DEPARTMENT 闭包/COMPANY；keyword/month 筛选） |
| `GET` | `/overtime/records/summary` | 管理月度汇总（范围内员工合计） |
| `GET` | `/overtime/records/export` | 管理导出（runExport：Redis 互斥 + REPEATABLE READ + 120s 超时；行数上限=平台设置 export.max.rows；导出完成写 EXPORT 操作日志） |

加班审批在统一审批中心处理（见 approval-center.md）：`overtime_approval` 功能（部门/公司档），
DEPARTMENT 档按部门闭包过滤待办；驳回必须填写原因；待审批批次只有提交人（或代提人）可取消。
审批中心列表支持导出（`GET /approval-requests/export`，可见性与数据范围与列表一致；导出完成写 EXPORT 操作日志，feature=`approval_center`）。

## 人事配置与字典（hr PRD §9）

权限：`hr_config`（公司档）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/hr-settings` | 全部人事设置（运行参数） |
| `PUT` | `/hr-settings/{key}` | 更新单条设置（即时生效，快照规则不追溯） |
| `GET` | `/dicts` | 字典列表（dictType/status 筛选 + 分页） |
| `POST` | `/dicts` | 新增字典项（幂等；同类型同名唯一） |
| `PUT` | `/dicts/{id}` | 更新字典项（名称/排序/启停） |
| `DELETE` | `/dicts/delete` | 批量硬删除（任一被业务引用整批拒绝——MVP 无引用表，机制保留） |

设置键：`overtime.advance.days`（提前申请窗口，默认 30）、`overtime.backfill.days`（补交窗口，默认 7）。

## 表格偏好（主 PRD §10.2 / T4-12）

仅需登录，无功能权限；账号维度读写（H-18，契约同 B-5）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET/POST` | `/me/table-prefs/{pageKey}/filter-presets` | 筛选预设列表 / 创建 |
| `PUT` | `/me/table-prefs/filter-presets/{id}` | 更新预设内容 |
| `PUT` | `/me/table-prefs/filter-presets/{id}/name` | 重命名预设 |
| `DELETE` | `/me/table-prefs/filter-presets/{id}` | 删除预设 |
| `GET/PUT` | `/me/table-prefs/{pageKey}/column-setting` | 列设置（每页一条，upsert） |

---

## 内部接口（主 PRD §9.4：内部令牌 + 调用方白名单）

### 岗位申请（base PRD §6 个人中心 P4/P5，调用方 platform-core）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/internal/v1/position-applications` | 提交岗位变更申请（`{ userId, targetDepartmentId, targetPositionId, idempotencyKey? }` → `{ requestId, applicationNo }`；多部门不可申请 `MULTI_DEPARTMENT_APPLY_FORBIDDEN`、目标条件 `POSITION_APPLY_TARGET_UNAVAILABLE`、待审批唯一 `PENDING_LIMIT_REACHED`；4xx 业务码原样返回） |
| `GET` | `/internal/v1/position-applications?userId=&page=&pageSize=` | 我的岗位申请记录（分页） |
| `GET` | `/internal/v1/users/{userId}/org` | 用户组织身份（departmentIds/Names、positionId/Name、canApplyPositionChange=部门数≤1；用户不存在返回空结构供 P2 降级） |

岗位申请审批（批准副作用）：审批通过时事务内重校验——员工仍无/单部门（多部门 → `POSITION_APPLY_STALE` 保持待审批）、
目标部门仍启用、目标岗位仍启用且允许自助申请且适用于目标部门；生效=所属部门更新为唯一目标部门、
岗位更新为目标岗位、`user_org_version++`。同一员工同时最多一条待审批岗位申请（条件唯一索引兜底）。

### 账号生命周期（backstage PRD §3，调用方 platform-core / worker）

| 方法 | 路径 | 调用方 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/internal/v1/lifecycle/restore-preview` | platform-core | 恢复兼容性预览（只读；组织关系兼容性检查，不写数据） |
| `POST` | `/internal/v1/lifecycle/restore-apply` | platform-core | 恢复应用（单事务整批；restoreRequestId 幂等——同键同目标集重放返回原结果、同键异目标集 `RESTORE_TARGET_STALE`(409)；事务内先幂等取消注销前待审批岗位申请，再应用组织兼容性清理并写 org_compat_records；任一目标失败整批回滚，调用方映射 CONFLICT 重新预览） |
| `POST` | `/internal/v1/lifecycle/cancel-position-applications` | worker | 幂等取消"注销前已提交且仍待审批"的岗位申请（`{ userId, deactivatedAt }` → `{ ok, cancelledCount }`；状态过滤天然幂等；cancelSource=ACCOUNT_DEACTIVATED + AUTO_CANCEL 动作） |

恢复兼容性规则：只保留仍存在且可用的部门关系（无有效部门则置空）；岗位不存在或不再适用于
全部保留部门时岗位置空（assigned_by 保留原值）；注销时 hr 停机导致生命周期任务未消费的场景由
restore-apply 事务内兜底取消覆盖，之后到达的生命周期任务仅幂等确认。

### 审批中心待办统计（T5-3，调用方 platform-core）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/internal/v1/approval-requests/pending-count?userId=` | 门户角标待办统计（口径与审批中心一致；DEPARTMENT 档按闭包裁剪） |
