# 安全与合规收尾核对清单（T10-5）

> 对照主 PRD §9.7（Web 安全基线）、§9.8（Redis 故障降级）、§9.14（单 ECS 部署安全边界）、
> backstage PRD §8（安全日志）逐项核对；每项标注落实方式与实现证据。本期只交付配置与代码，
> 不执行实际部署（部署后的 HTTPS 证书、安全组等宿主侧动作在 ECS 部署时落实）。

## §9.7 Web 安全基线

| 项 | 结论 | 证据/落实方式 |
| --- | --- | --- |
| 仅 HTTPS 对外提供 | 配置就绪（部署时启用） | `deploy/nginx.conf` 提供 80 入口并注释 443 启用方式；§9.14 安全组仅开放 80/443 |
| CSP / HSTS / X-Content-Type-Options / 防点击劫持 / Referrer-Policy | 已落实 | `deploy/nginx.conf` 统一 add_header：CSP（self + OSS https 图片）、HSTS、nosniff、X-Frame-Options SAMEORIGIN、Referrer-Policy |
| CORS 仅明确域名 | 已落实 | 后端未启用 `app.enableCors`（同源网关，无跨域来源）；浏览器同源访问，CORS 无通配配置 |
| 会话 Cookie httpOnly + secure + sameSite | 已落实 | 会话 Cookie `HttpOnly` + `SameSite=Lax`；生产 `COOKIE_SECURE=true`（compose platform-core 环境注入） |
| 状态变更请求 CSRF 校验 | 已落实 | `CsrfGuard` 双提交校验（T0-4/T2 实现）；幂等键头桥接 `IdempotencyHeaderInterceptor` |
| 钉钉回调一次性 state/nonce | 已落实 | 钉钉授权流程一次性 state + 流程 Cookie（T2-1）；错误码含 `DINGTALK_STATE_INVALID` |
| 密码 Argon2id 加盐哈希 | 已落实 | `password.service.ts` Argon2id（memoryCost 19456 / timeCost 2 / parallelism 1）；8～32 位校验 |
| 敏感数据不进前端持久存储/普通日志 | 已落实 | 凭证仅 fragment 内存/流程 Cookie；会话标识不落日志；访问日志脱敏 |
| 登录/钉钉/邀请激活/密码重置/上传/导出/批量/跨服务限流 | 已落实 | 各接口限流（IP/账号/流程 Cookie 维度，T2/T4 实现）；上传 20MiB 上限 + 413（本阶段修复）；导出单用户并发 429；跨服务内部令牌恒定时间校验 |
| 机密从环境注入、不入设置表 | 已落实 | 数据库/钉钉/OSS/Cookie/内部令牌均由环境注入；`deploy/.env.production.example` 占位模板；无前端明文回显 |

## §9.8 Redis 单实例与故障降级

| 项 | 结论 | 证据/落实方式 |
| --- | --- | --- |
| 单实例、固定命名空间 | 已落实 | 生产 compose 单一 redis 服务；`redisKey` 命名空间约定（T0-5） |
| AOF + RDB 持久化、noeviction | 配置就绪 | `deploy/docker-compose.yml` redis command：`--appendonly yes --appendfsync everysec --maxmemory-policy noeviction`；命名卷 `redis_data` |
| 启动强检（连接/PING/读写探测） | 已落实 | `assertRedisAvailable`（T0-5/§9.8）；探测失败非零退出不监听端口 |
| 运行中失效 → 就绪探针失败 + 业务 503 | 已落实 | `readyz` 依赖 `redis.isReady`；受保护接口依赖 Redis 会话（T2-4） |
| 恢复后自动重建就绪 | 已落实 | ioredis 自动重连 + 就绪探针恢复（既有实现） |
| 数据库恢复时清空 Redis | 已落实 | 恢复管道 `FLUSHDB` 步骤（T4-8）；恢复执行器不依赖 Redis 维持状态 |

## §9.14 单 ECS 部署安全边界

| 项 | 结论 | 证据/落实方式 |
| --- | --- | --- |
| 仅 Nginx 公网入口 | 配置就绪 | compose 仅 web 发布 `80:80`；其余容器无 ports |
| `/internal/v1` 不暴露公网 | 配置就绪 | nginx.conf 不配置 internal 路由（`location /api/ { return 404; }`）；内部端口仅私网 |
| 无 Docker Socket / privileged / host 网络 | 配置就绪 | compose 全部容器 `cap_drop: ALL` + `no-new-privileges`；无 socket 挂载、无 host 网络 |
| 非 root + 只读根文件系统 + 有界 tmpfs | 配置就绪 | runtime 镜像 `USER wbme`；`read_only: true` + `tmpfs: /tmp` |
| 命名持久化卷（不写容器可写层） | 配置就绪 | `postgres_data` / `redis_data` 命名卷；恢复状态与发布基线用 `/opt/wbme/persist` 宿主目录 |
| 机密文件权限最小化 | 配置就绪 | `.env.production` 不入库/不入镜像（dockerignore）；部署文档注明 600 权限 |
| 时钟同步 | 配置就绪 | `release.sh` 发布核验含时钟检查（timedatectl） |
| 健康探针免登录最小状态 | 已落实 | `/healthz /readyz` 仅返回最小状态（platform-core/业务服务/恢复执行器） |

## backstage PRD §8 安全日志

| 项 | 结论 | 证据/落实方式 |
| --- | --- | --- |
| 事件范围与 PRD 清单一致 | 已落实 | 安全事件枚举（T4-4 审查通过） |
| 敏感值不落库 | 已落实 | 上下文脱敏（手机号脱敏、凭证摘要、令牌不记录）；T4-4 审查通过 |

## 部署后待落实（不在本期执行）

- [ ] HTTPS 证书签发与 443 配置（`deploy/nginx.conf` 已预留说明）
- [ ] ECS 安全组仅开放 80/443；SSH 密钥认证 + 来源限制
- [ ] 生产机密文件权限（chmod 600）与 `.env.production` 注入
- [ ] 实际发布、恢复演练与容器运行验证（阶段 10 部署约束：本期不执行）
