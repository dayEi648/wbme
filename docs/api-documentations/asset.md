# asset 服务 API 文档（阶段7）

> 统一前缀 `/api/v1`（内部接口 `/internal/v1`）；错误结构、幂等键、分页遵循主 PRD §9.5。
> 权限：所有业务路由经全局会话守卫；功能授权在服务内断言（未注册/未授权 → 404 不泄露存在性，
> 系统未开放 → `SYSTEM_NOT_OPEN`(503)）。
> 数据范围：`DEPARTMENT` 档按当前用户部门闭包（hr.department_closure 视图：部门及全部下级、
> 多部门并集）过滤；`COMPANY` 档全量。
> 数量与额度：物品变动数量一律正整数（整数存储，负数由业务方向表达）；提交文本不接受小数、零、负数、科学计数法或非数值文本（`transformPositiveInt` 严格解析）；可用库存 = 账面 − 占用。
> 金额：REST 传输为最多两位小数的十进制字符串（主 PRD §9.11）。

## 通用错误码（ASSET / INVENTORY 域）

| code | HTTP | 说明 |
| --- | --- | --- |
| `ASSET_STATUS_INVALID` | 422 | 资产当前状态不允许该操作（状态机规则） |
| `MAINTENANCE_ACTIVE_EXISTS` | 409 | 同一资产存在进行中的维修单（条件唯一索引） |
| `ASSET_REFERENCED` | 422 | 资产仍在使用或有业务关联，不允许删除 |
| `ASSIGNEE_DEPARTMENT_MISMATCH` | 422 | 调度目标责任人必须属于目标所属部门 |
| `ASSET_TRANSFER_NO_CHANGE` | 422 | 部门与责任人均未变化，无需调度 |
| `CATEGORY_REFERENCED` | 422 | 分类仍被资产/品种引用，不允许删除 |
| `DICT_REFERENCED` | 422 | 字典项仍被业务数据引用，不允许删除 |
| `ASSET_IMAGE_INVALID` | 400 | 主图对象标识无效 |
| `QR_INVALID` | 404 | 二维码无效或已停用（解析失败统一 404 不泄露目标详情） |
| `QR_REVOKED` | 422 | 二维码已作废，无法恢复 |
| `INSUFFICIENT_STOCK` | 422 | 库存不足（占用后不满足 占用 ≤ 账面） |
| `INSUFFICIENT_QUOTA` | 422 | 超出申领额度上限（周期上限 / 同时持有上限） |
| `STOCK_CONFLICT` | 409 | 库存/批次并发变化，条件不再成立（整次拒绝） |
| `ITEM_DUPLICATED` | 400 | 同一物品在清单中只能出现一次 |
| `CONSUMABLE_REFERENCED` | 422 | 品种仍存在库存或业务引用，不允许删除 |
| `UNIT_LOCKED` | 422 | 品种已产生业务事实，单位不可修改 |
| `BATCH_CORRECTION_FORBIDDEN` | 422 | 批次存在后续流水或待审批占用，规格不可纠正 |
| `CONSUMABLE_DISABLED` | 422 | 品种已停用 |
| `LOCATION_HAS_CHILDREN` | 422 | 存在未删除的子库位，请先处理 |
| `LOCATION_REFERENCED` | 422 | 库位仍存在库存或业务引用，不允许删除 |
| `LOCATION_INVALID_TARGET` | 422 | 目标库位不存在、已停用或与来源库位相同 |
| `BORROW_ALREADY_SETTLED` | 422 | 借还记录已结清 |
| `SETTLEMENT_COVERAGE_INCOMPLETE` | 422 | 结清清单必须覆盖全部未结清数量 |
| `DISPOSAL_FORBIDDEN` | 409 | 注销处置条件已变化（账号已恢复/数量超限/状态变化），整次拒绝 |
| `RECIPIENT_INVALID` | 400 | 代领受领人名单无效（选择自己/重复/不在范围内） |

审批通用错误（`STATUS_CONFLICT` 409、`PENDING_LIMIT_REACHED` 409、`SCOPE_NOT_COVERED` 403）见 approval-center.md。

---

## 资产配置（asset PRD §12）

权限：`asset_config`（公司档）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/asset-settings` | 全部运行参数（扫码入口地址、申领上限重置日） |
| `PUT` | `/asset-settings` | 更新运行参数（整组提交，缺省字段保持现值；重置日 1～28，变更只影响之后开始的周期） |
| `GET` | `/categories` | 分类全量列表（顶级 + 一级子分类；状态过滤） |
| `POST` | `/categories` | 创建一级子分类（幂等；顶级分类为系统内置「固定资产/消耗品」，业务只能维护其下的一级子类；固定资产只能归入固定资产分类，消耗品只能归入消耗品分类，跨顶级归入拒绝） |
| `PUT` | `/categories/{id}` | 编辑分类（名称/排序/启停） |
| `DELETE` | `/categories/batch` | 批量硬删除（任一分类被资产/品种引用整批回滚） |
| `GET` | `/dict-items` | 业务字典列表（dictType/status 筛选 + 分页） |
| `POST` | `/dict-items` | 新增字典项（幂等；同类型同名唯一） |
| `PUT` | `/dict-items/{id}` | 更新字典项（名称/排序/启停） |
| `DELETE` | `/dict-items/batch` | 批量硬删除（任一被业务引用整批回滚） |

字典类型：`UNIT`（单位）/ `CHANGE_TYPE`（库存变更类型，仅表示意外扣减原因）/ `SUPPLIER` / `BRAND` /
`SPEC` / `ASSET_SPEC` / `ASSET_MODEL`。受控选项只能使用已启用值；停用值不能自动恢复；历史数据引用保留原值展示。

## 固定资产台账（asset PRD §4）

权限：我的资产 `my_assets`（SELF）；固定资产查看 `fixed_asset_view`（部门/公司档只读）；
固定资产维护 `fixed_asset_maintain`（部门/公司档，隐含查看）。状态机：闲置/使用中可普通编辑互切，
已报废是业务状态（继续显示在台账、可筛选，可通过编辑恢复为闲置/使用中）；待维修/维修中只由维修管理产生和流转。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/assets/mine` | 我的资产（scope=OWNED/USED/ALL；同一资产同时命中两类时合并为一条） |
| `GET` | `/assets` | 台账分页（分类/部门/状态/归属/责任人/使用者/关键字筛选；DEPARTMENT 按资产所属部门闭包裁剪） |
| `GET` | `/assets/export` | 台账导出（runExport：Redis 互斥 + REPEATABLE READ + 120s 超时；行数上限=平台设置 export.max.rows；导出所有未逻辑删除或全部筛选结果；导出完成写 EXPORT 操作日志） |
| `GET` | `/assets/{id}` | 详情（含调度历史/变更历史/维修单；范围外 404） |
| `POST` | `/assets` | 建档（幂等；金额必填两位小数；主图对象标识经 T4-10 上传） |
| `PUT` | `/assets/{id}` | 编辑基础资料/使用者/主图（责任人与所属部门变化必须走调度；状态仅 IDLE/IN_USE 互切或 SCRAPPED 恢复；变更记录只追加） |
| `POST` | `/assets/{id}/schedule` | 调度（目标责任人必须属于目标部门 `ASSIGNEE_DEPARTMENT_MISMATCH`；部门与责任人均未变化 `ASSET_TRANSFER_NO_CHANGE`；写调度记录；来源与目标部门均须在授权闭包内） |
| `POST` | `/assets/{id}/scrap` | 报废（二次确认 confirm=true；业务状态非删除） |
| `DELETE` | `/assets/batch` | 批量软删除（存在进行中维修单等业务关联整批拒绝） |

## 维修管理（asset PRD §4）

权限：`fixed_asset_maintain`（部门/公司档）。登记/取消/开始/完成均为状态+版本条件更新，
并发重复操作只有一个成功；同一资产同一时刻最多一张进行中维修单（事务内校验 + 条件唯一索引）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/repair-orders` | 登记维修（幂等；仅闲置/使用中资产；保存维修前状态快照并把资产置待维修） |
| `POST` | `/repair-orders/{id}/cancel` | 取消登记（待维修 → 已取消终态，资产恢复登记前状态；不删除该单；维修中不能取消） |
| `POST` | `/repair-orders/{id}/start` | 开始维修（待维修 → 维修中；记录开始时间；资产转维修中） |
| `POST` | `/repair-orders/{id}/complete` | 维修完成（维修中 → 已完成；填结果/实际费用/完成时间；耗时自动计算；资产恢复为所选状态） |
| `GET` | `/repair-orders` | 维修单列表（资产/状态筛选 + 分页） |
| `GET` | `/repair-orders/{id}` | 详情（含状态流转历史） |

## 消耗品品种与库位（asset PRD §5）

权限：品种与库位配置为 `asset_config`（公司档）；申领页的只读目录查询使用 `consumable_apply`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/consumables` | 品种列表（配置查询需 `asset_config`；`hasAvailableStock=true` 为申领页品种汇总，需 `consumable_apply`，仅启用且有可用库存，筛选和 total 在分页前计算） |
| `POST` | `/consumables` | 创建品种（幂等；类型创建后不可变；一次性必填周期+上限、借还必填归还期限+同时持有上限） |
| `PUT` | `/consumables/{id}` | 编辑品种（类型不可变；有业务事实后单位不可修改 `UNIT_LOCKED`；品类参数只影响之后新提交/新借出；停用后不可新建入库/申领，既有库存与待审批不受影响） |
| `DELETE` | `/consumables/batch` | 批量硬删除（存在当前库存/未结清借还/待审批引用整批拒绝；删除后同名可再建） |
| `GET` | `/warehouses/tree` | 库位树全量（状态过滤） |
| `POST` | `/warehouses` | 创建库位（幂等；禁止父子循环） |
| `PUT` | `/warehouses/{id}` | 编辑库位（名称/排序/启停/移动节点；环校验；改名/移动只影响当前树，历史快照不追溯改写） |
| `DELETE` | `/warehouses/batch` | 批量硬删除（存在未删除子库位或现存库存/未结清借还/待审批引用整批拒绝；停用后不能作为新入库/调拨目标，现存库存可调出） |

## 库存条目、批次与流水（asset PRD §5）

权限：库存管理为 `inventory_manage`（公司档）。账面/占用/可用一致性由各业务事务保证（整数精度）。
员工申领目录例外：`GET /inventory/items?availableOnly=true` 使用 `consumable_apply`，仅返回启用且
可用库存大于 0 的条目，返回的 `id` 即提交申领所需的 `inventoryItemId`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/inventory/items` | 库存条目列表（库存管理需 `inventory_manage`；`availableOnly=true` 为员工申领目录并需 `consumable_apply`；品种/库位/规格筛选 + 分页；含可用数量与低库存标记，计算条件在分页前执行） |
| `GET` | `/inventory/batches` | 批次列表（条目/品种/库位筛选 + 分页；含剩余数量；调拨子批次带 source_batch_id 追溯） |
| `POST` | `/inventory/batches/{id}/corrections` | 批次资料纠正（供应商/品牌/单价/备注直接纠正并记录前后值+原因；规格/库位仅当批次无后续流水且来源条目无待审批占用时可纠正，同一事务归并账面并写 CORRECTION 流水） |
| `GET` | `/inventory/stock-flows` | 库存流水列表（品种/类型/来源/时间筛选 + 分页；只追加不可编辑） |
| `GET` | `/inventory/stock-flows/export` | 流水导出（runExport 同上；导出完成写 EXPORT 操作日志） |

## 入库与库存变更申请（asset PRD §6）

权限：提交/本人历史 `stock_in_apply` / `stock_change_apply`（SELF，隐含本人历史）；
范围历史 `stock_in_history` / `stock_change_history`（部门/公司档）。清单式提交，整单进入审批
（整单批准或驳回，驳回必填原因）；批准后按行形成批次并生成流水 / 按批次 FIFO 扣减。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/stock-in-requests` | 提交入库申请（幂等；行=品种+供应商/品牌/规格/库位+数量+可选单价；整单可填申请时间；提交不占用库存；批准后按行建批次并增加库存，入库仅增） |
| `GET` | `/stock-in-requests/mine` | 本人入库申请历史 |
| `GET` | `/stock-in-requests` | 范围入库申请历史（审批状态/发起时间/发起人姓名筛选） |
| `POST` | `/stock-change-requests` | 提交库存变更申请（幂等；仅意外扣减，MVP 不支持增加库存；变更类型必填（字典 `CHANGE_TYPE`，系统初始化含「其他意外扣减」）；同一库存条目整单一次；提交时锁定条目并原子占用，任一行不足整单不创建；批准后按批次 FIFO 扣减并生成流水，驳回/取消同事务释放占用） |
| `GET` | `/stock-change-requests/mine` | 本人库存变更申请历史 |
| `GET` | `/stock-change-requests` | 范围库存变更申请历史 |

## 轻量库存调拨（asset PRD §6）

权限：`inventory_manage`（公司档）。写接口携带幂等键；提交时服务端在事务内按稳定 ID 顺序锁定
来源条目并重新计算可用库存，超限/状态变化/并发 → 整次 `STOCK_CONFLICT`，不产生调拨记录或任何流水。
底层批次按 FIFO 分配，每段在目标库位创建带 source_batch_id 的调拨子批次（继承采购来源）；
TRANSFER_OUT / TRANSFER_IN 成对流水，全部来源减少量之和 = 全部目标增加量。调拨完成后不可编辑/删除，
纠正误调拨 = 从当前实际所在条目重新发起反向调拨。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/asset/inventory-transfers` | 创建调拨（幂等键；fromInventoryItemId + toWarehouseId + qty + remark；目标库位必须启用且不同于来源库位；来源库位停用仍可调出；品种已停用但仍有库存时允许移库） |
| `GET` | `/asset/inventory-transfers` | 调拨记录列表（品种/规格/来源库位/目标库位/操作者/时间筛选；默认时间倒序） |
| `GET` | `/asset/inventory-transfers/{id}` | 调拨详情（批次分配明细 + 成对流水） |

## 消耗品申领（asset PRD §7）

权限：普通申领/本人历史 `consumable_apply`（SELF）；代交申领 `proxy_apply`（部门/公司档）；
范围历史 `consumable_apply_history`（部门/公司档）。

普通申领：提交时按条目固定顺序锁定并原子占用库存 + 个人额度（一次性用品按「员工+品种+当前周期」
已批准+待审批+本次 ≤ 上限；借还用品按「员工+品种」未结清持有+待审批+本次 ≤ 同时持有上限；
周期键按北京时间+申领上限重置日计算，以提交时间归属，额度配置与周期提交时快照持久化）；
整单全有或全无，任一行库存不足/额度不足整单不创建且不产生任何占用。批准后把占用转换为出库
（FIFO 批次）与额度 CONSUMED，借还类同时生成借还记录（到期时间 = 出库时间 + 归还期限快照）；
驳回/取消同一事务释放。

代交申领：「受领人名单 + 一张共享物品清单」；不能选择自己、不能重复、须为数据范围内在职员工；
库存占用与出库只按共享清单总数量计算一次，不占任何个人额度；批准后借还类生成清单级（AGENT）
借还记录（无个人借用人）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/consumable-requests` | 提交普通申领（幂等；行=库存条目+数量+用途） |
| `GET` | `/consumable-requests/mine` | 本人申领历史 |
| `GET` | `/consumable-requests` | 范围申领历史（requestType/状态/发起人筛选） |
| `POST` | `/agent-requests` | 提交代交申领（幂等；recipientIds 1~100 去重 + 共享物品清单） |
| `GET` | `/agent-requests/mine` | 本人代交申领历史（含受领人名单） |
| `GET` | `/agent-requests` | 范围代交申领历史 |

## 借还、归还与核销（asset PRD §8）

权限：我的借还/发起归还/发起核销 `my_borrow`（SELF）；借还历史 `borrow_history`（部门/公司档）。

可申请处理数量 = 未结清 − 待审批归还占用 − 待审批核销占用（派生计算，无独立占用表）；
提交时锁定借还记录并按公式校验，批准把占用转换为已归还/已核销，驳回或取消占用随终态自然消失。
归还批准回库到原批次（按该申请 ISSUE 流水段逐段恢复批次剩余与条目账面并写 RETURN 流水）；
核销批准不回库；逾期只提示不阻止。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/my-borrow` | 我的借还（结清状态/逾期筛选 + 分页；含本人作为受领人的代领共享清单只读视图，不计个人持有） |
| `POST` | `/borrow-returns` | 发起归还申请（幂等；行=借还记录+数量+备注；待确认数量仍计入持有量） |
| `POST` | `/borrow-write-offs` | 发起核销申请（幂等；行=借还记录+数量+遗失/损坏类型+原因必填；从持有量结清不回库） |
| `GET` | `/borrow-records` | 借还历史（记录类型/借用人/代交人/受领人/部门/结清状态/逾期筛选；DEPARTMENT 按借出时部门快照/发起人/受领人快照闭包过滤） |

代领一次性整单结清（权限：`proxy_apply`，发起人操作）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/agent-settlements` | 提交代领结清（幂等；必须覆盖全部未结清数量，每种物品各处理方式数量之和 = 全部未结清；同一代领清单最多一条待审批结清 `PENDING_LIMIT_REACHED`；批准时单事务一次完成全部回库/核销/流水/清单结清） |
| `GET` | `/agent-settlements/mine` | 本人代领结清申请历史 |

## 注销员工借还直接处置（asset PRD §8/§9）

权限：`consumable_approval`（部门/公司档；审批中心「注销员工借还处置」功能）。
非审批类型：不创建申请、不进入待审批、不需再次审批，确认成功即最终业务结果，不计入六类待办。
同一事务重新校验借用人/发起人仍为注销状态（已恢复 → `DISPOSAL_FORBIDDEN`）、数据范围
（PERSONAL 按借出时部门快照全部部门 ∈ 审批人闭包；AGENT_SETTLE 按受领人名单全部部门快照闭包）、可处理数量
（与待审批归还/核销申请互斥：先提交的申请先占）；直接归还在事务中回库+流水，直接核销不回库；
必须携带幂等键，写入不可删除的管理员直接处置记录（含关联流水引用）与操作日志。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/disposals?tab=PENDING` | 待处置列表（数据范围内已注销员工未结清个人借还 + 发起人已注销且可整单结清的代领共享清单） |
| `GET` | `/disposals?tab=RECORDS` | 处置记录（处理时间倒序；记录类型/借用人/代交人/处理方式/处理人/时间筛选） |
| `POST` | `/disposals` | 直接处置（必须携带幂等键；disposalType=RETURN/WRITE_OFF（个人借还明细）或 AGENT_SETTLE（代领整单结清明细）；返回 `{ id, recordIds }`，其中 `recordIds` 为本次创建的全部处置记录，归还流水以对应处置记录 id 追溯） |

## 二维码（asset PRD §11）

公开标识为独立、至少 128 位随机性的不透明标识（256 bit），不编码内部 ID；标识不是登录凭证或
授权秘密，扫码后仍由服务端解析并执行登录、权限与状态校验。URL 使用前端固定扫码入口并把公开
标识放在 URL fragment（`/scan#<publicId>`，不进 Nginx/HTTP 日志与 Referer）；解析接口限流，
服务端日志不记录完整标识。管理动作：停用 / 恢复 / 作废并重新生成（REVOKED 终态不可恢复；
重新生成只更换入口标识，不修改业务数据；同一目标同时最多一张未作废二维码）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/qr-codes` | 创建二维码（ASSET 目标归 `fixed_asset_maintain`；INVENTORY_ITEM/SCAN_CATALOG 归 `inventory_manage`） |
| `GET` | `/qr-codes` | 二维码列表（目标类型/状态筛选 + 分页；按用户管理权限过滤目标类型：`fixed_asset_maintain` 仅见 ASSET，`inventory_manage` 仅见 INVENTORY_ITEM/SCAN_CATALOG） |
| `POST` | `/qr-codes/{id}/action` | 管理动作（DISABLE/ENABLE/REGENERATE；按目标类型归属权限——ASSET 归 `fixed_asset_maintain`，其余归 `inventory_manage`；已作废不可操作） |
| `POST` | `/qr-codes/parse` | 扫码解析（限流：IP 60 次/分 + 用户 120 次/分；解析后按当前用户功能权限/数据范围/目标状态/库存状态校验——INVENTORY_ITEM 需持 `consumable_apply`；无权限/目标已删除/二维码无效/条目不可申领统一 404 不泄露目标详情） |

## 表格偏好（主 PRD §10.2 / T4-12）

仅需登录，无功能权限；账号维度读写（A-30，契约同 B-5）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET/POST` | `/me/table-prefs/{pageKey}/filter-presets` | 筛选预设列表 / 创建 |
| `PUT` | `/me/table-prefs/filter-presets/{id}` | 更新预设内容 |
| `PUT` | `/me/table-prefs/filter-presets/{id}/name` | 重命名预设 |
| `DELETE` | `/me/table-prefs/filter-presets/{id}` | 删除预设 |
| `GET/PUT` | `/me/table-prefs/{pageKey}/column-setting` | 列设置（每页一条，upsert） |

---

## 审批中心（asset PRD §9）

六类申请（库存入库 `STOCK_IN` / 库存变更 `STOCK_CHANGE` / 消耗品申领 `CONSUMABLE_REQUEST` /
归还 `RETURN` / 遗失损坏核销 `WRITE_OFF` / 代领结清 `AGENT_SETTLEMENT`）在统一审批中心
（`/api/v1/approval-requests`）处理，权限统一为「消耗品审批」`consumable_approval`
（部门/公司档）；DEPARTMENT 档不可见公司专属的入库与库存变更类型，并按部门闭包裁剪。
六类待办不展示审批截止时间；申请保持待审批直至批准/驳回/取消/超时自动取消
（默认 30 天每日扫描，取消时同一事务释放占用）。接口契约与导出见 approval-center.md。
申请人或代交人另可通过 `GET /approval-requests/mine` 查看本人全部资产申请历史（不要求审批权限），
并对待审批记录调用 `POST /approval-requests/{id}/cancel` 主动取消。

批准业务副作用（同一事务，任一部分失败整单回滚、申请保持待审批）：
入库批准按行建批次并增加库存；库存变更批准按批次 FIFO 扣减；申领批准出库（FIFO）+ 额度转
CONSUMED + 借还记录生成；归还批准回库到原批次；核销批准不回库；代领结清批准一次完成全部
回库/核销/流水/清单结清。驳回与取消（含超时自动取消）按类型释放库存占用与额度占用。

## 内部接口（主 PRD §9.4：内部令牌 + 调用方白名单）

### 审批中心待办统计（T5-3，调用方 platform-core）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/internal/v1/approval-requests/pending-count?userId=` | 门户角标待办统计（口径与审批中心一致；DEPARTMENT 档按闭包裁剪） |
