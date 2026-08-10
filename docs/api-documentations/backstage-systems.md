# backstage 系统开放状态 API 文档

> 统一前缀 `/api/v1`；错误结构、幂等键遵循主 PRD §9.5。
> 本文档随接口提交同步维护；文档与实现不一致视为任务未完成（实现规划通用任务约定）。
> 批次 4 起：原「系统与业务结构」页面与板块/功能说明维护接口已删除，系统开放状态切换
> 迁移至「系统设置」书签（权限随迁 `system_settings`）。

## 通用约定

- **权限要求**：登录态 + 持有"系统设置"功能（`system_settings`）授权或超级管理员
  （`FunctionPermissionGuard`，守卫链语义见 `backstage-permission.md` 通用约定）。
- **catalog_version 语义**：状态调整**不递增**全局权限目录版本
  （主 PRD §3.1：仅功能新增/移除/归属/可选数据范围变化才递增）。
- **即时生效**：门户入口与函数权限守卫实时读取 `product_status`——系统置为 `COMING_SOON` 后，
  该系统功能的请求由守卫返回 `503 SYSTEM_NOT_OPEN`（含超管）；重新开放不改变任何授权。
- **操作日志**：写操作写 backstage.operation_logs（feature=`system_settings`，含变更前后值），支持幂等键。

## Y1 系统列表查询 `GET /systems`

- 成功：`{ systems: [{ code, name, productStatus }] }`（按目录排序；BASE 不在目录）
- 仅返回系统级信息（编码/名称/开放状态），供系统设置书签切换状态

## Y2 调整系统开放状态 `PUT /systems/{code}/status`

- 入参：`{ productStatus: 'OPEN' | 'COMING_SOON', idempotencyKey? }`
- 规则：仅 ASSET/HR/FIN 可调；backstage 恒开放 → `SYSTEM_STATUS_NOT_ADJUSTABLE`(422)；
  未注册编码（含 BASE）→ `RESOURCE_NOT_FOUND`(404)
- 成功：`{ ok: true }`（幂等重放返回首次结果）；操作日志 UPDATE（`COMING_SOON → OPEN` 前后值）
