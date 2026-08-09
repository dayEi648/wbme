# backstage 系统与业务结构管理 API 文档

> 统一前缀 `/api/v1`；错误结构、幂等键遵循主 PRD §9.5。
> 本文档随接口提交同步维护；文档与实现不一致视为任务未完成（实现规划通用任务约定）。
> 目录结构（系统/板块/功能的归属、排序、注册）由代码目录权威定义（启动对账），
> 本组接口只开放系统开放状态与业务说明维护（backstage PRD §6）。

## 通用约定

- **权限要求**：登录态 + 持有"系统与业务结构管理"功能（`system_structure_manage`）授权或超级管理员
  （`FunctionPermissionGuard`，守卫链语义见 `backstage-permission.md` 通用约定）。
- **catalog_version 语义**：状态调整与 description 维护**不递增**全局权限目录版本
  （主 PRD §3.1：仅功能新增/移除/归属/可选数据范围变化才递增）；管理员维护的 description
  不会被启动对账覆盖。
- **即时生效**：门户入口与函数权限守卫实时读取 `product_status`——系统置为 `COMING_SOON` 后，
  该系统功能的请求由守卫返回 `503 SYSTEM_NOT_OPEN`（含超管）；重新开放不改变任何授权。
- **操作日志**：写操作写 backstage.operation_logs（feature=`system_structure_manage`，含变更前后值），支持幂等键。

## Y1 结构树查询 `GET /systems`

- 成功：`{ systems: [{ code, name, productStatus, sort, sections: [{ code, name, description, sort,
  functions: [{ code, name, description, dataScopeOptions, sort }] }] }] }`（按目录排序；BASE 不在目录）

## Y2 调整系统开放状态 `PUT /systems/{code}/status`

- 入参：`{ productStatus: 'OPEN' | 'COMING_SOON', idempotencyKey? }`
- 规则：仅 ASSET/HR/FIN 可调；backstage 恒开放 → `SYSTEM_STATUS_NOT_ADJUSTABLE`(422)；
  未注册编码（含 BASE）→ `RESOURCE_NOT_FOUND`(404)
- 成功：`{ ok: true }`（幂等重放返回首次结果）；操作日志 UPDATE（`COMING_SOON → OPEN` 前后值）

## Y3 维护板块业务说明 `PUT /systems/{systemCode}/sections/{sectionCode}/description`

- 入参：`{ description: string（≤500；空白 = 清除为 NULL）, idempotencyKey? }`
- 成功：`{ ok: true }`；失败：`RESOURCE_NOT_FOUND`(404 系统/板块未注册)

## Y4 维护功能业务说明 `PUT /systems/functions/{functionCode}/description`

- 入参/成功/失败：同 Y3（functionCode 全局唯一）；说明在授权界面悬停展示
