# 项目目录结构

> 查看项目结构以本文件为准；结构变化时同步更新。

```
wbme/
├── apps/                        # 部署单元与前端
│   ├── platform-core/           # base + backstage 后端（认证、权限、平台基础设施）
│   ├── asset/                   # 资产系统后端（台账/库存/借还/审批/二维码）
│   ├── hr/                      # 人事系统后端（组织/加班/审批/账号生命周期）
│   ├── fin/                     # 财务系统后端（合同/利润分析/Excel 导入导出）
│   ├── web/                     # 前端（Vite + React + Ant Design）
│   ├── worker/                  # BullMQ Worker（Outbox 调度 + 后台任务消费）
│   ├── recovery-executor/       # 数据库恢复执行器
│   └── migration-runner/        # 迁移执行器（开发/发布统一执行迁移）
├── packages/                    # @wbme 共享包
│   ├── contracts/               # 共享契约（错误码/DTO/枚举/权限目录）
│   ├── server/                  # NestJS 共享基础设施（请求链路/会话/内部 REST/导出）
│   ├── approval/                # 统一审批内核
│   ├── logging/                 # 操作日志模板与集中日志受限语句
│   ├── tasks/                   # 统一后台任务受限接口（Outbox SQL）
│   └── files/                   # 文件存储与 OSS 约定
├── docs/                        # 项目文档
│   ├── prds/                    # PRD（主 PRD + 各子系统）
│   ├── api-documentations/      # API 文档与 OpenAPI 构建期产物
│   ├── database-design/         # 数据库表结构设计
│   ├── for-frontend/            # 前端设计规范
│   └── references/              # 参考资料（利润分析 Excel 模板等）
├── scripts/                     # 工程脚本（一键启动、E2E 种子）
│   └── db-views/                # 只读视图脚本（Migration Runner 统一执行）
├── deploy/                      # 生产部署（Dockerfile/Compose/Nginx/发布脚本/恢复演练）
├── .agents/                     # 内部工作目录（计划、临时图片）
│   └── plans/                   # 计划与待办清单
└── .github/                     # CI 工作流
```

说明：

- 各后端部署单元与前端在 `apps/` 下平级；业务模块位于各后端 `src/modules/` 下，按模块目录组织。
- 共享包仅供内部消费，随全平台同一 Git commit 版本化。
- `deploy/` 本期只交付部署配置与脚本，不执行实际部署。
