# WBME 协作与 CI/CD 流程

> 本文档定义两人开发团队的协作方式、Git 分支模型、CI 门禁与生产发布流程。
> 发布约束（版本只前进、Migration Runner、更新日志自动生成等）见主 PRD §9.9、backstage PRD §10。

---

## 1. 仓库

- 托管：**GitHub 私有仓库**，单仓库 monorepo（前端 + 4 个后端部署单元 + Worker + 恢复执行器 + 全部文档）。
- **单仓库的原因**：主 PRD §1.3 要求"每次生产发布以一个 Git commit 作为整个平台版本"，全部组件必须从同一 commit 构建，多仓库无法满足。
- `main` 分支受保护：**要求 CI 检查通过**；不强制 PR 审查（两人小团队、直接推送 + 自动门禁）。未来需要变更痕迹时随时可切换为 PR 流程，不改变其余约定。

## 2. 分支与提交

- **主干开发**：日常开发直接提交 `main`；提交前先 `git pull --rebase` 拉取对方变更，冲突自己解决。
- **提交规范**：Conventional Commits，标题中英双语（见 CLAUDE.md §3）。
- **高冲突区协调**：以下改动会同时影响两人，动手前先与对方同步，避免无谓合并冲突：
  - Prisma 迁移文件（`migrations/` 下 4 套迁移序列）；
  - 共享包：错误码目录、功能权限目录定义、统一审批契约、日志/任务模块、DTO；
  - 只读视图脚本（操作日志联合视图、职称视图、站点角色视图）。
- 同时开发时优先改不同文件；不可避免同文件时先口头分工再提交。

## 3. 版本与发布模型

- **版本 ≠ 每个 commit**：日常 commit 在 `main` 上累积；发布时才在选定的 commit 上打语义化标签（`v0.1.0` 起递增）。
- 一次发布 = **一个 tag = 一个 commit**，全部组件从该 commit 构建（主 PRD §1.3）。
- 发布流程（人工触发，发布脚本随部署工程实现）：
  1. 发布人选定 tag，执行受控发布命令；
  2. 校验目标 commit 是"上次成功部署 commit"的后继（版本只前进，主 PRD §9.9）；
  3. 检测到待执行迁移 → 先自动创建并校验"立即备份"，再由 Migration Runner 按部署单元顺序执行迁移；
  4. 构建全部组件镜像到同一 commit → 优雅重启（就绪检查）；
  5. 按"上次部署 commit → 本次 commit"范围自动生成更新日志（release_logs）。
- **回滚不存在**：生产缺陷通过新的修复 commit 向前发布；数据库备份恢复仅用于灾难恢复（主 PRD §9.9）。

## 4. CI（GitHub Actions）

- 触发：push `main` 与 pull_request。
- 门禁内容：pnpm 安装（npmmirror 镜像源）→ lint → typecheck → Vitest 单元测试 → 构建。
- 工程基座阶段后扩展：Prisma 迁移可执行性校验（临时 PostgreSQL 上 `migrate deploy`）、Playwright E2E、镜像构建。
- 说明：runner 为 GitHub 托管（海外执行），依赖安装统一使用 npmmirror 镜像与开发机保持一致。

## 5. 开发环境

- 两人各自本地 `docker compose up`（PostgreSQL + Redis），**不共享开发数据库**，避免迁移与数据互相污染。
- 数据库结构变更只通过迁移文件随代码走；开发环境的 compose 启动时由一次性 Migration Runner 执行迁移（主 PRD §9.9）。

## 6. 机密管理

- 所有 `.env*` 不提交（已在 .gitignore）；生产机密（数据库连接串、钉钉密钥、OSS 凭证、Cookie 签名密钥、内部服务令牌）由部署环境注入，不进 Git、不进镜像层（主 PRD §9.14）。
- CI 需要的凭证存入 GitHub 仓库级 Secrets，仅 workflow 内引用。

## 7. 新成员开发环境初始化（一次性，每台机器各做一次）

1. **GitHub 账号与权限**：确认个人 GitHub 账号；联系仓库 owner（dayEi648）把自己添加为仓库 **Collaborators**（Settings → Collaborators，写权限）。
2. **本机 SSH 认证**（每台机器一次）：生成 `ssh-keygen -t ed25519 -C "github"`，把 `~/.ssh/id_ed25519.pub` 内容添加到**个人** GitHub（Settings → SSH and GPG keys → New SSH key）。首次连接 GitHub 若提示 Host key verification failed，执行 `ssh-keyscan -H github.com >> ~/.ssh/known_hosts`（指纹与 GitHub 官方公布值比对确认）。
3. **克隆与安装**：`git clone git@github.com:dayEi648/wbme.git`；安装 pnpm（corepack 或独立安装），项目根执行 `pnpm install`（国内镜像源）。
4. **本地环境**：`docker compose up`（PostgreSQL + Redis + 各服务），Migration Runner 随启动执行迁移（主 PRD §9.9）。
5. **日常开发**：`git pull --rebase` 后提交 `git push`，认证一次配置后全程无感；提交规范见 §2。

> 认证方式说明：每人用**自己的** GitHub 账号与 SSH key，互不共享；仓库写权限由 owner 通过 Collaborators 控制。若个人偏好 HTTPS，可改用 Personal Access Token + macOS Keychain 记忆，效果相同。

## 8. 分工建议

- 初期按部署单元分工：一人负责 `platform-core`（base + backstage，含共享包维护），另一人负责一个业务模块（建议先 asset）；hr / fin 待骨架稳定后分配。
- 共享包（权限目录、审批契约、错误目录、日志/任务模块）由 platform-core 负责人维护，业务模块负责人使用时以 review 形式把关。
- 数据库表设计文档（`docs/database-design/`）为双方共同基线，改表先改文档、再改迁移。
