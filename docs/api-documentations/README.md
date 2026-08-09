# API 文档目录约定

- `*.md` 为各部署单元接口文档（手写，随接口提交同步维护；文档与实现不一致视为任务未完成）。
- `openapi/platform-core.openapi.json` 为 platform-core 的 OpenAPI 产物（主 PRD §9.5）：由构建期脚本生成并提交进版本库。
  **新增/变更接口（路由、DTO、错误码、权限要求）时执行 `pnpm --filter @wbme/platform-core openapi:generate`
  重新生成并随代码同一次提交**；CI 以 `openapi:verify` 校验产物与代码一致（不一致即失败）。
- 产物约定：错误结构 `ErrorResponse` 的 type/domain/code 枚举从 `@wbme/contracts` 错误目录自动生成，
  不手抄；DTO 与描述来自 swagger 编译器插件（docstring 即描述），控制器只补 `@ApiTags` 等最少标注。
- 阶段 4 平台基础设施（手写文档）：
  - `backstage-stage4-infra.md`：系统设置、操作日志、系统日志（错误/安全）
  - `backstage-stage4-ops.md`：更新日志/公告、备份恢复、健康状态、表格偏好、导出约定
- 平台文件存储（手写文档）：
  - `files-images.md`：图片预签名上传/正式化/限时下载（T4-10 接线）
- 阶段 5 统一审批（手写文档）：
  - `approval-center.md`：三部署单元审批中心契约、内部 pending-count、超时扫描
- asset/hr 审批中心接口已上线（T5）；其余业务接口上线时沿用同一模式（nest-cli swagger 插件 + 构建期生成脚本 +
  产物提交 + verify 接入 CI），产物命名 `<unit>.openapi.json`。
- 各部署单元接口文档（手写）：`asset.md`（T7）、`hr.md`（T6）、`fin.md`（T8 工程合同/利润分析/Excel 导入导出/操作记录/财务配置），
  OpenAPI 产物 `asset.openapi.json` / `hr.openapi.json` / `fin.openapi.json` 由各单元 `openapi:generate` 生成并提交。
