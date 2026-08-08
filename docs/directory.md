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
| `docs/api-documentations/` | API 文档（`base-auth.md` 认证链路与用户管理操作；`backstage-permission.md` 权限管理；`backstage-users.md` 用户管理与 hr 生命周期内部契约） |
| `docs/dev-workflow.md` | 协作与 CI/CD 流程（Git 分支模型、版本与发布、CI 门禁、开发环境、机密管理、分工建议） |

## apps（部署单元与前端）

| 路径 | 用途 |
| --- | --- |
| `apps/platform-core/` | platform-core 部署单元（base + backstage 逻辑模块；Prisma multi-schema 见 `prisma/`；base 认证链路见 `src/modules/base/`：auth/dingtalk/session/security-log/settings/login-protection/portal/me/approval-proxy；backstage 见 `src/modules/backstage/`：permission-catalog 权限目录启动对账、permission 员工授权 CRUD 与权限组（含授权校验基础：授权查询服务/函数权限守卫）、user-admin 用户管理（创建/列表/编辑，生命周期编排随后续迭代）） |
| `apps/asset/` | 资产系统部署单元 |
| `apps/hr/` | 人事系统部署单元 |
| `apps/fin/` | 财务系统部署单元 |
| `apps/web/` | 前端（Vite + React + Ant Design；认证与门户页面见 `src/pages/`，统一请求层见 `src/request/`） |
| `apps/worker/` | BullMQ Worker 部署单元 |
| `apps/recovery-executor/` | 数据库恢复执行器部署单元 |
| `apps/migration-runner/` | Migration Runner（按部署单元顺序执行迁移与视图脚本） |

## packages（@wbme 共享包）

| 路径 | 用途 |
| --- | --- |
| `packages/contracts/` | 共享契约：错误码目录、BusinessException、DTO 基类、枚举、功能权限目录权威定义（`src/permission/catalog.ts`，主 PRD §3.1）、金额/时区约定 |
| `packages/server/` | NestJS 共享基础设施：请求上下文、全局异常过滤器、校验管道、拦截器、Redis、健康探针、内部 REST、会话/CSRF（含提权旋转标记与透明轮换） |
| `packages/approval/` | 统一审批内核（T5 实现） |
| `packages/logging/` | 操作日志模板与集中日志受限语句（T4 实现） |
| `packages/tasks/` | 统一后台任务受限接口（T4 实现） |
| `packages/files/` | 文件存储与 OSS 约定（T4 实现） |

## scripts（工程脚本）

| 路径 | 用途 |
| --- | --- |
| `scripts/dev.mjs` | 开发环境一键启动（依赖检查 → 构建共享包 → Migration Runner → 并行启动各服务） |
| `scripts/db-views/` | 幂等只读视图脚本（站点角色、操作日志联合视图、职称视图；Migration Runner 统一执行） |
