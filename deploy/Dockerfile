# syntax=docker/dockerfile:1
# WBME 生产镜像（主 PRD §1.3：一次发布 = 一个 commit，全部组件从同一构建产物启动）。
# 单 Dockerfile 多 target：
#   builder —— 依赖安装 + Prisma Client 生成 + 全部构建产物
#   web     —— Nginx + 前端静态产物（docker-compose 的 web 服务）
#   runtime —— 后端/Worker/恢复执行器/Migration Runner 共用的最小运行环境（docker-compose 各服务）

# ---- 构建阶段 ----
FROM node:24-bookworm-slim AS builder
WORKDIR /wbme

# 根配置文件（锁文件为唯一来源；.npmrc 固定国内镜像源）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

# pnpm 版本以 packageManager 字段为准（corepack 读取 lockfile 自动启用）
RUN corepack enable
RUN pnpm install --frozen-lockfile

# Prisma Client 生成（不连接数据库；占位连接串仅满足 prisma.config.ts 的 env() 解析）
ENV DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder
RUN pnpm prisma:generate

# 共享包先构建（typecheck/build 依赖各包 dist），随后全部应用构建
RUN pnpm -r build

# ---- 前端 + Nginx ----
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /wbme/apps/web/dist /usr/share/nginx/html
EXPOSE 80
# 官方 nginx 镜像 master 进程（PID 1）以 root 运行、worker 降权 nginx（镜像固定行为）；
# 特权收窄由 Compose 完成（cap_drop ALL + no-new-privileges + read_only）；健康检查由 Compose 执行

# ---- 后端运行时 ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /wbme

# 备份/恢复处理器需要 PostgreSQL 18 客户端（pg_dump/pg_restore/psql，主 PRD §9.3）。
# bookworm 默认源只到 15，使用阿里云 PostgreSQL 镜像源安装 18（与国内网络环境对齐；
# 2026-08 实测：清华无 pgdg 路径、华为云仅同步到 16，阿里云/腾讯云 /postgresql/repos/apt 含 client-18）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://mirrors.aliyun.com/postgresql/repos/apt/ACCC4CF8.asc | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://mirrors.aliyun.com/postgresql/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/pgdg.list /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg

# 运行时仅保留依赖、共享包产物与应用产物（含 Prisma 生成代码与迁移文件）
COPY --from=builder /wbme/node_modules ./node_modules
COPY --from=builder /wbme/packages ./packages
COPY --from=builder /wbme/apps ./apps

# 非 root 最小权限运行用户（主 PRD §9.14）
RUN useradd -r -u 10001 -m wbme && chown -R wbme:wbme /wbme
USER wbme

EXPOSE 3001 3002 3003 3004
