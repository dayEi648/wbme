# fin 服务 API 文档

> 统一前缀 `/api/v1`（内部接口 `/internal/v1`）；错误结构、幂等键、分页遵循主 PRD §9.5。
> 权限：所有业务路由经全局会话守卫；功能授权在服务内断言（未注册/未授权 → 404 不泄露存在性，
> 系统未开放 → `SYSTEM_NOT_OPEN`(503)）。
> 只读能力（列表/详情/操作记录/利润分析/导出）由 `finance_view` 或 `finance_maintain` 任一开放
> （维护隐含包含查看）；写能力（新建/编辑/删除/明细/即时保存/导入）仅 `finance_maintain`；
> 配置能力（字典/设置）仅 `finance_config`。财务数据均为全公司范围，无部门/本人维度。
> 金额：REST 传输为最多两位小数的十进制字符串（主 PRD §9.11）；自动计算字段可得到真实负数，
> 不截断；毛利率以内部比率字符串传输（`0.25` 表示 25%），收款为零时返回 `null`（前端显示“—”）。

## 通用错误码（FINANCE 域；导入并发/超时错误见 EXPORT 域）

| code | HTTP | 说明 |
| --- | --- | --- |
| `PROJECT_KEY_CONFLICT` | 409 | 项目业务键（规范化名称 + 年度）冲突，含软删除占键（进入已删除视图恢复或改名） |
| `DATA_REVISION_STALE` | 409 | 项目 dataRevision 前置条件失败（Excel 覆盖防预览后变化） |
| `DICT_REFERENCED` | 409 | 字典项被历史项目引用，批量删除整批拒绝（可停用后新建替代项） |
| `DICT_SEMANTIC_LOCKED` | 409 | 项目进度金额语义被引用后不可修改（停用并新建选项） |
| `UNCLASSIFIED_NAME_CONFLICT` | 400 | 业务分类不得使用系统虚拟分组保留名“未分类” |
| `CELL_FIELD_NOT_ALLOWED` | 400 | 单元格即时保存提交了多个业务字段或未注册字段 |
| `IMPORT_FILE_TOO_LARGE` | 413 | 上传文件超过 20 MiB 固定上限 |
| `IMPORT_ROW_LIMIT_EXCEEDED` | 400 | 项目数据行超过 10,000 行上限 |
| `IMPORT_ARCHIVE_LIMIT_EXCEEDED` | 400 | ZIP 解压体积/条目数超过安全上限（200 MiB / 1,000 条目） |
| `IMPORT_FORMULA_NOT_ALLOWED` | 400 | 可导入手工字段出现公式（自动计算列白名单除外，导入端忽略重算） |
| `IMPORT_YEAR_REQUIRED_FOR_NEW` | 400 | 空年度行无法定位新增项目（新增必须提供年度） |
| `IMPORT_YEAR_AMBIGUOUS` | 409 | 同名跨年度记录导致空年度行匹配歧义 |
| `IMPORT_PREVIEW_STALE` | 409 | 预览后数据变化（确认事务 dataRevision 前置失败），整批回滚 |
| `IMPORT_PROJECT_DELETED` | 409 | 导入命中软删除项目（只提示冲突，不自动恢复） |
| `IMPORT_SHEET_INVALID` | 400 | 工作表结构/28 列有序表头/A1:AB1 合并与 V2 模板签名不匹配 |
| `IMPORT_CONFIRM_MISMATCH` | 400 | 确认选择与重新解析的行不一致（行号/目标项目/版本缺失） |
| `IMPORT_ALREADY_RUNNING` | 429 | 单用户导入并发占用冲突（预览与确认共用导入锁；与导出锁相互独立） |
| `IMPORT_TIMEOUT` | 503 | 导入超过 120 秒固定总时限（受控取消并完整回滚） |

---

## 工程合同（fin PRD §3）

权限：读 = `finance_view`（维护隐含包含）；写 = `finance_maintain`。

项目名称与年度共同构成业务唯一键（Unicode NFC 规范化 + 首尾去空白 + 连续空白归一 + 拉丁字母大小写折叠，
页面与导入使用完全相同规则）；软删除记录仍占用业务键。自动计算字段不落库，由后端基于最新明细实时计算。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/projects` | 项目列表（名称/甲方/年度/地区/业务分类/进度筛选 + 分页；`view=deleted` 查已删除视图，仅供批量恢复；行含三类明细与自动字段） |
| `POST` | `/projects` | 新建项目（幂等；字典引用保存 ID+名称快照；金额 ≥ 0 两位小数；`PROJECT_KEY_CONFLICT` 冲突） |
| `GET` | `/projects/{id}` | 详情（完整合同资料 + 三类明细 + 自动字段与利润数据入口；已删除 404） |
| `PUT` | `/projects/{id}` | 编辑（名称/年度允许随时修改，保存时校验新业务键；提交前后无实际差异不产生项目操作记录） |
| `PUT` | `/projects/deleted/restore` | 已删除项目批量恢复（幂等；1～100 个；全有或全无；保留原 ID/业务键/数据与操作历史；任一不存在或未删除整批回滚并返回失败明细） |
| `DELETE` | `/projects/batch` | 批量软删除（幂等；全有或全无；任一不存在或已删除整批回滚并返回失败明细；已删除项目不进入正常列表/筛选/统计/导出） |

## 金额明细（fin PRD §3/§4）

三种明细类型：`invoice`（开票金额）/ `receipt`（已收回款）/ `subcontract-payment`（已付分包款），
三表结构同构。每次只变更一条明细；单条物理删除例外（主 PRD §2.6：删除前在同一事务写入完整删除前
快照审计，审计失败删除同步回滚，删除后不可恢复）。每次成功变更递增项目 `dataRevision`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/projects/{projectId}/details/{type}` | 新增明细（金额必填 ≥ 0；日期 YYYY-MM-DD；备注可空） |
| `PUT` | `/projects/{projectId}/details/{type}/{detailId}` | 修改明细（每次一条；前后无实际差异不产生操作记录） |
| `DELETE` | `/projects/{projectId}/details/{type}/{detailId}` | 单条物理删除（删除前完整快照审计同事务） |

## 利润分析（fin PRD §4）

权限：读/导出 = `finance_view`（维护隐含包含）；即时保存 = `finance_maintain`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/profit/projects` | 分析列表（筛选分页 + 每行自动字段：累计开票/收款、剩余未开票/未收款、累计分包付款、暂定保通权益、毛利率） |
| `GET` | `/profit/totals` | 总计汇总（当前筛选范围全部项目，不受当前页分页影响；毛利率按汇总后再除，收款为零 null） |
| `PUT` | `/profit/cells` | 单元格即时保存（一次一个白名单字段 + 幂等键；只写目标字段——不同字段并发互不覆盖、同字段以最后提交为准；响应返回重算自动字段与 `dataRevision`，修订号仅用于响应排序不作保存前置；无实际差异不产生操作记录） |

白名单字段：`name`/`year`/`partyA`/`generalContractor`/`managementFee`/`subcontractors`/`contractStartDate`/
`contractEndDate`/`contractAmount`/`paymentNode`/`tentativeAuditedAmount`/`settlement`/`miscExpense`/
`remark`/`completenessDocs`/`regionId`/`progressId`/`bizCategoryId`（自动计算字段不可手工修改；
`name`/`year` 变更联动业务键重新校验唯一）。

## Excel 导入（fin PRD §4）

权限：`finance_maintain`。上传固定上限 20 MiB（Multer 拦截，超限 `IMPORT_FILE_TOO_LARGE` 413）；
仅接受单个工作表的 `.xlsx`；服务端在 CPU 工作池内解析（ZIP 安全上限 200 MiB/1,000 条目、拒绝加密/
嵌套/路径穿越/符号链接，公式白名单，模板签名校验）；原文件不写 OSS/PostgreSQL/Redis/磁盘，
请求结束不保留文件内容；预览与确认各持单用户并发锁（与导出锁独立），120 秒固定总时限。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/profit/excel/import/preview` | multipart 单文件预览：解析 + 匹配生成「新增/待选择/跳过/冲突/错误」精简清单（不回传整行副本；待选择项携带目标 `dataRevision` 与覆盖丢失明细日期/备注的警告标记；无服务端状态） |
| `POST` | `/profit/excel/import/confirm` | 携带同一文件 + 选择映射（Excel 行号 → 覆盖/跳过）+ 幂等键确认：重新解析并以行号解释选择；覆盖以 `dataRevision` 条件更新（预览后变化 → `IMPORT_PREVIEW_STALE` 整批回滚）；新增/覆盖/明细重建/审计批量写入同一事务（全有或全无）；覆盖会物理删除原金额明细（日期/备注清空重建），审计保留替换前后完整快照 |

匹配规则：带年度行按规范化名称 + 年度精确匹配；空年度行按名称唯一匹配（不猜测年份，多条同名 →
`IMPORT_YEAR_AMBIGUOUS`，无记录新增 → `IMPORT_YEAR_REQUIRED_FOR_NEW`）；软删除命中只冲突不恢复；
文件内重复（同业务键或同目标项目）判重冲突。分组行取所在分组上下文（“未分类”映射空分类；
不匹配现有业务分类的单 B 列行按空年度数据行解释）。

## Excel 导出（fin PRD §4）

权限：`finance_view`（维护隐含包含）。固定 V2 模板（28 列有序表头 + A1:AB1 标题合并），
动态行样式由版本化常量生成（绿色分组行、浅灰小计行、暂定浅黄/审定浅绿语义色、负数红字）；
导出所有/导出已筛选（不受当前页分页影响）；REPEATABLE READ 一致性快照 + 键集分批读取；
稳定排序（真实业务分类配置顺序 → 未分类最后 → 年度升序 → 项目 ID 升序）；金额写两位小数数值 +
数字格式、毛利率写数值比率 + `0.00%` 格式、多值单元格按 LF 换行；用户文本一律普通单元格值。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/profit/excel/export/{scope}` | scope=`all`（权限范围内全部未删除）或 `filtered`（当前筛选）；附件直接响应；与平台通用导出共用同一用户并发锁（429 `EXPORT_ALREADY_RUNNING`）；行数上限 = 平台设置 `export.max.rows`（超限 422 `ROW_LIMIT_EXCEEDED`）；120 秒总时限（503 `EXPORT_TIMEOUT`）；导出成功后写 EXPORT 操作日志 |

## 项目操作记录（fin PRD §5）

权限：随 `finance_view` 开放（维护隐含包含）；只读列表与详情，只追加不可改删，项目删除后仍保留。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/project-operations` | 列表（时间倒序；`projectId` 过滤 + 分页） |
| `GET` | `/project-operations/{id}` | 详情（按字段展示变更前后内容） |

动作枚举：`CREATE`/`EDIT`/`DELETE`/`IMPORT_CREATE`/`IMPORT_OVERWRITE`/`IMPORT_SKIP`；
单字段即时保存与明细变更记录 `field` + 前后单值；整表单编辑与导入覆盖记录字段映射/完整明细快照；
提交前后无实际差异时不产生记录；审计与业务变更同一数据库事务。

## 财务配置（fin PRD §6）

权限：`finance_config`（公司档）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/finance-dict-items` | 字典列表（dictType/status 筛选 + 分页；sort/id 升序） |
| `POST` | `/finance-dict-items` | 新增字典项（幂等；同类型同名唯一；PROGRESS 必填金额语义；业务分类不得叫“未分类”） |
| `PUT` | `/finance-dict-items/{id}` | 更新字典项（名称/语义/排序/启停；PROGRESS 语义被引用后不可修改 `DICT_SEMANTIC_LOCKED`） |
| `DELETE` | `/finance-dict-items/batch` | 批量硬删除（幂等；任一被项目引用整批拒绝 `DICT_REFERENCED`；停用项历史项目仍按快照展示） |
| `GET` | `/finance-settings` | 财务配置读取（F-7；MVP 无固定运行参数，返回空列表，机制保留） |
| `PUT` | `/finance-settings` | 更新财务配置（只接受已注册键，当前为空集，任意键拒绝） |

字典类型：`PROGRESS`（项目进度，金额语义 `TENTATIVE`/`AUDITED`——未选进度按暂定处理）/ `COMPLETENESS`
（资料齐全度）/ `BIZ_CATEGORY`（业务分类）/ `REGION`（地区，跨系统地区选项统一在财务系统维护）。

## 个人表格偏好（F-9；主 PRD §10.2）

仅需登录，无功能权限；账号维度读写（筛选预设 + 列设置），与 base B-5 / hr H-18 / asset A-30 同构契约。
路由：`/me/table-prefs/{pageKey}/filter-presets`（GET/POST）、`/me/table-prefs/filter-presets/{id}`
（PUT 内容 / PUT `name` / DELETE）、`/me/table-prefs/{pageKey}/column-setting`（GET/PUT）。
