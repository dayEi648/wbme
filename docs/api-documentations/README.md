# API 文档目录约定

## 浏览器公开网关路径

服务内部仍统一实现 `/api/v1`，浏览器只通过同源网关访问下列稳定公开前缀。网关将独立业务服务
的前缀重写为容器内 `/api/v1` 后转发；`/internal/v1` 永不暴露给浏览器。

| 归属服务 | 浏览器公开前缀 | 容器内前缀 |
| --- | --- | --- |
| platform-core（base/backstage） | `/api/v1` | `/api/v1` |
| asset | `/api/asset/v1` | `/api/v1` |
| hr | `/api/hr/v1` | `/api/v1` |
| fin | `/api/fin/v1` | `/api/v1` |

开发环境由 Vite 代理遵循此契约；生产环境 Nginx 按相同规则实现。此映射避免独立服务
间同名资源（例如审批与表格偏好）发生路由冲突。

- `*.md` 为各部署单元接口文档（手写，随接口提交同步维护；文档与实现不一致视为任务未完成）。
- `openapi/platform-core.openapi.json` 为 platform-core 的 OpenAPI 产物（主 PRD §9.5）：由构建期脚本生成并提交进版本库。
  **新增/变更接口（路由、DTO、错误码、权限要求）时执行 `pnpm --filter @wbme/platform-core openapi:generate`
  重新生成并随代码同一次提交**；CI 以 `openapi:verify` 校验产物与代码一致（不一致即失败）。
- 产物约定：错误结构 `ErrorResponse` 的 type/domain/code 枚举从 `@wbme/contracts` 错误目录自动生成，
  不手抄；DTO 与描述来自 swagger 编译器插件（docstring 即描述），控制器只补 `@ApiTags` 等最少标注。
- 平台基础设施（手写文档）：
  - `backstage-stage4-infra.md`：系统设置、操作日志、系统日志（错误/安全）
  - `backstage-stage4-ops.md`：更新日志/公告、备份恢复、健康状态、表格偏好、导出约定
- 平台文件存储（手写文档）：
  - `files-images.md`：图片预签名上传/正式化/限时下载
- 统一审批（手写文档）：
  - `approval-center.md`：三部署单元审批中心契约、内部 pending-count、超时扫描
- 各部署单元接口文档（手写）：`asset.md`、`hr.md`、`fin.md`（工程合同/利润分析/Excel 导入导出/操作记录/财务配置），
  OpenAPI 产物 `asset.openapi.json` / `hr.openapi.json` / `fin.openapi.json` 由各单元 `openapi:generate` 生成并提交。

## 幂等写请求

对请求体类型继承 `IdempotentDto` 的写接口，客户端可在 body 中提交 `idempotencyKey`，也可使用标准
`Idempotency-Key` 请求头。服务端只会在目标 `@Body()` DTO 明确继承 `IdempotentDto` 时，将请求头安全映射
到该字段；body 已显式提供值时优先保留。认证、扫码解析等非幂等 DTO 不接收该字段，仍由全局白名单拒绝未知入参。

## 表格查询通用载荷

所有继承 `PaginationQueryDto` 的列表端点接受可选 `filters` 和 `sorts` JSON：
`filters` 为树形条件组 `filters={ logic, conditions: [...] }`——`conditions` 的元素为条件
`{ field, operator, value, valueEnd? }` 或一层嵌套子组 `{ logic, conditions: [...] }`；组内统一
AND/OR，条件组最多 2 层嵌套。旧版平铺 `{ logic, conditions }` 与条件组
`{ logic: 'OR', groups: [{ logic: 'AND', conditions: [...] }] }` 形状继续兼容，服务端统一归一化
为条件树解释。操作符除比较类（`EQUALS`/`NOT_EQUALS`/`CONTAINS`/`NOT_CONTAINS`/大小比较/`BETWEEN`/
`BEFORE`/`AFTER`）外，还包括空值类（`IS_EMPTY`/`IS_NOT_EMPTY`）、文本首尾匹配（`STARTS_WITH`/
`ENDS_WITH`）与相对日期（`TODAY`/`THIS_WEEK`/`THIS_MONTH`/`LAST_7_DAYS`/`LAST_30_DAYS`，由服务端
按 Asia/Shanghai 当天动态求值，无需传值）；日期区间使用 `operator: 'BETWEEN'` 与 `value/valueEnd`。
`sorts=[{ field, direction }]` 表示按顺序的多级排序。
服务端仅按该资源已注册的字段白名单解释条件；前端同时传递同名的既有具名查询参数，保证已上线的
分页、权限与索引约束不被绕过。任何未知字段、SQL 片段或未声明筛选都不会被拼接或执行。

## 统一分页响应

所有列表路由（包括配置、树节点、我的记录和只读操作记录）只返回如下结构，不再返回历史的
`{ items, total }` 形状：

```json
{
  "data": [],
  "pagination": { "page": 1, "pageSize": 20, "totalItems": 0, "totalPages": 0 }
}
```

`page` 从 1 开始，默认 `page=1&pageSize=20`，`pageSize` 最大为 100。详情、汇总和运行参数等
非列表路由不使用该包装。前端应只读取 `data` 与 `pagination`，不得为旧形状保留兼容分支。

## 导出请求时限

全局 HTTP 请求时限为 30 秒；所有工作簿导出路由显式使用 120 秒路由级时限，与导出服务的
一致性快照、互斥锁和事务时限保持一致。超时返回业务错误，不把仍在执行的导出伪装成成功。
