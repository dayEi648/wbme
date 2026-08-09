# wbme 项目目录

## docs

| 路径 | 用途 |
| --- | --- |
| `docs/prds/prd.md` | 主 PRD：平台级通用需求（总体架构、平台级机制、公共基础设施、前端、非功能、规划、技术方案） |
| `docs/prds/base/prd.md` | 基础模块 PRD（注册登录、会话、门户、个人中心） |
| `docs/prds/backstage/prd.md` | 管理后台 PRD（用户、权限界面、系统设置、日志、公告、备份、健康状态） |
| `docs/prds/asset/prd.md` | 资产系统 PRD |
| `docs/prds/hr/prd.md` | 人事系统 PRD |
| `docs/prds/fin/prd.md` | 财务系统 PRD |
| `docs/prds/ai/prd.md` | 智能模块 PRD（预留） |
| `docs/prds/agent/prd.md` | 智能对话 Agent PRD（预留） |
| `docs/for-frontend/` | 前端设计规范（Ant Design 主题与设计文档） |
| `docs/database-design/` | 数据库表结构设计（`00-baseline.md` 公共基线 + `base.md`/`backstage.md`/`hr.md`/`asset.md`/`fin.md` 各模块表设计） |
| `docs/references/` | 参考资料（利润分析 Excel 模板等） |
| `docs/api-documentations/` | API 文档（`README.md` 目录约定；`base-auth.md` 认证链路；`approval-center.md` 统一审批中心（T5，T6 接入 hr 部门闭包与批准副作用，T7 接入 asset 六类业务副作用）；`backstage-permission.md` 权限管理；`backstage-users.md` 用户管理/超管任免与 hr 生命周期内部契约；`backstage-systems.md` 系统与业务结构管理；`backstage-stage4-infra.md` Stage 4 设置/操作日志/系统日志；`backstage-stage4-ops.md` Stage 4 运维（公告/备份/健康/导出/表格偏好）；`hr.md` hr 服务 API（T6：组织/部门/岗位/职称/节假日/加班/岗位申请/人事配置/生命周期内部接口）；`asset.md` asset 服务 API（T7：配置/分类/字典/台账/维修/品种/库位/库存/入库变更/调拨/申领/借还/处置/二维码/表格偏好）；`openapi/` OpenAPI 构建期产物（platform-core / hr / asset）） |
| `docs/dev-workflow.md` | 协作与 CI/CD 流程（Git 分支模型、版本与发布、CI 门禁、开发环境、机密管理、分工建议） |

## apps（部署单元与前端）

| 路径 | 用途 |
| --- | --- |
| `apps/platform-core/` | platform-core 部署单元（base + backstage；`src/modules/base/table-prefs` 表格偏好；backstage `content` 公告/更新日志、`backup` 备份恢复、`health-status` 健康状态、`operation-log`/`system-log` 日志查询等） |
| `apps/asset/` | 资产系统部署单元（T7 全功能：`src/modules/` 下 approval 审批中心（含部门闭包与六类业务副作用）、asset 固定资产台账、repair 维修管理、consumable 品种、warehouse 库位、inventory 库存条目/批次/纠正/流水、request 入库与库存变更申请、transfer 轻量调拨、claim 普通与代交申领、borrow 借还/归还/核销/代领结清、disposal 注销员工借还直接处置、qr 二维码、settings 资产配置、catalog 分类与字典、base/table-prefs 表格偏好） |
| `apps/hr/` | 人事系统部署单元（T6 全功能：`src/modules/` 下 approval 审批中心（含部门闭包与批准副作用）、org 组织/部门/岗位/岗位申请（含内部接口）、title 职称、holiday 节假日适配器、overtime 加班、settings 人事配置与字典、lifecycle 账号生命周期内部接口、base/table-prefs 表格偏好） |
| `apps/fin/` | 财务系统部署单元 |
| `apps/web/` | 前端（Vite + React + Ant Design；认证与门户页面见 `src/pages/`，统一请求层见 `src/request/`） |
| `apps/worker/` | BullMQ Worker 部署单元（Outbox 调度 + 统一后台任务消费；`src/outbox-scheduler.ts`、`src/background-task-worker.ts`、`src/processors/`） |
| `apps/recovery-executor/` | 数据库恢复执行器部署单元 |
| `apps/migration-runner/` | Migration Runner（按部署单元顺序执行迁移与视图脚本） |

## packages（@wbme 共享包）

| 路径 | 用途 |
| --- | --- |
| `packages/contracts/` | 共享契约：错误码目录、BusinessException、DTO 基类、枚举、功能权限目录权威定义（`src/permission/catalog.ts`，主 PRD §3.1）、金额/时区约定 |
| `packages/server/` | NestJS 共享基础设施：请求上下文、全局异常过滤器、校验管道、拦截器、Redis、健康探针、内部 REST、会话/CSRF（含提权旋转标记与透明轮换） |
| `packages/approval/` | 统一审批内核（状态机/版本条件更新/范围/待审批限制/超时扫描；T5-1） |
| `packages/logging/` | 操作日志模板与集中日志受限语句（T4 实现） |
| `packages/tasks/` | 统一后台任务受限接口：任务类型常量、稳定 UUID、Outbox SQL、状态条件更新（T4-2） |
| `packages/files/` | 文件存储与 OSS 约定（`presignImageUpload` / `finalizeImage` / `presignBackupUpload`；T4-10） |

## scripts（工程脚本）

| 路径 | 用途 |
| --- | --- |
| `scripts/dev.mjs` | 开发环境一键启动（依赖检查 → 构建共享包 → Migration Runner → 并行启动各服务） |
| `scripts/db-views/` | 幂等只读视图脚本（站点角色、操作日志联合视图、职称视图；Migration Runner 统一执行） |
