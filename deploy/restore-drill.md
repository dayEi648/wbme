# 数据库恢复演练（backstage PRD §10）

> 本期交付演练步骤与命令模板，**实际演练在部署到 ECS 后进行**（阶段 10 部署约束）。
> 前置：生产环境已按 `docker-compose.yml` 部署且完成一次成功发布；以下命令在 ECS 部署机的
> `deploy/` 目录执行（`./release.sh` 同目录、`.env.production` 就绪）。

## 演练目标

验证「数据库损坏 → 维护状态 → 外部清单恢复 → 正向迁移 → 恢复后校验」全流程，确认：

1. 恢复执行器经 `RESTORE_STATE_DIR` 持久目录在数据库不可用时仍可启动并保持维护状态；
2. 恢复管道以**外部控制清单**为唯一事实来源，不依赖即将被替换的数据库；
3. 恢复完成后发布基线重新对齐到当前运行 commit（主 PRD §9.9），下一次发布不重复收集已上线提交。

## 演练前置（非破坏性检查）

> 恢复状态目录 `/opt/wbme/persist/restore-state`（compose `RESTORE_STATE_DIR`）由
> `release.sh` 部署时自动预建并 chown 至恢复执行器容器 uid（10001）；手工部署
> （不经 release.sh）时须先预建：`mkdir -p /opt/wbme/persist/restore-state && chown 10001:10001 /opt/wbme/persist/restore-state`。

```bash
# 1. 恢复执行器就绪（状态目录读写 + 控制配置；数据库不可连不阻断）
docker compose --env-file .env.production exec -T recovery-executor node -e \
  "fetch('http://127.0.0.1:3090/recovery/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 2. 确认最近备份存在（管理后台「数据备份」页或 OSS backups/ 前缀）
docker compose --env-file .env.production exec -T worker node -e \
  "console.log('备份由后台任务与迁移前钩子生成；此处确认 OSS 中存在 backups 清单')"
```

## 演练步骤

### 步骤 1：触发一次「立即备份」

在管理后台「数据备份」页执行立即备份，记录备份 ID；或在 ECS 上经内部接口触发：

```bash
INTERNAL_TOKEN="$(grep '^INTERNAL_SERVICE_TOKEN=' .env.production | cut -d= -f2-)"
# 备份异步执行：先触发，返回 backupId；再轮询状态直至 SUCCEEDED（caller 白名单仅 migration-runner）
docker compose --env-file .env.production exec -T platform-core node -e '
  fetch("http://127.0.0.1:3001/internal/v1/backups/immediate", {
    method: "POST",
    headers: { "authorization": "Bearer " + process.argv[1], "x-wbme-caller": "migration-runner", "content-type": "application/json" },
    body: "{}",
  }).then(r => r.json()).then(d => { console.log(JSON.stringify(d)); process.exit(d.error ? 1 : 0); })
' "$INTERNAL_TOKEN"
```

```bash
# 轮询备份状态（替换 <backupId> 为上一步返回的 backupId）；SUCCEEDED 后才可进入下一步
docker compose --env-file .env.production exec -T platform-core node -e '
  const id = Number(process.argv[1]);
  fetch("http://127.0.0.1:3001/internal/v1/backups/immediate/status/" + id, {
    headers: { "authorization": "Bearer " + process.argv[2], "x-wbme-caller": "migration-runner" },
  }).then(r => r.json()).then(d => { console.log(JSON.stringify(d)); process.exit(d.status === "SUCCEEDED" ? 0 : 1); })
' "<backupId>" "$INTERNAL_TOKEN"
```

> 注：备份触发也可使用管理后台「数据备份」页（同一效果）。确认备份状态为成功后，**记录 backupId 供步骤 3 使用**。

### 步骤 1.5：签发恢复控制会话 Cookie（须在停止服务前）

> **时序要求（M32 复核修正）**：步骤 2 会停止 platform-core 与 web，而恢复控制 Cookie 的签发
> （`POST /api/v1/restores/session`，需超管平台登录会话 + data_backup 权限）依赖 platform-core
> 运行——Cookie 必须在步骤 2 **之前**签发。控制会话有效期 60 分钟，覆盖步骤 2→4 的窗口。
>
> **控制通道（backstage PRD §10，批次 8 修复）**：维护状态下 Nginx 额外放行 `/recovery/` 到
> 恢复执行器（非维护状态 404），浏览器可经 `https://<入口>/recovery/status`（GET）与
> `/recovery/retry`（POST）携带本 Cookie 操作。演练步骤 2 停止 web 容器后浏览器不可达，
> 改用下述 docker exec 直连（同 Cookie）。

```bash
# 从浏览器 DevTools 复制超管登录的完整 Cookie（wbme_session=...; wbme_csrf=...，两者都要）：
# CSRF 双提交校验要求非 GET 携带会话 Cookie 的请求同时带 X-WBME-CSRF-Token 头，
# 头值必须与 wbme_csrf Cookie 值完全一致（主 PRD §9.7）。
docker compose --env-file .env.production exec -T platform-core node -e '
  const cookie = process.argv[1];
  const csrf = /(?:^|; )wbme_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  fetch("http://127.0.0.1:3001/api/v1/restores/session", {
    method: "POST",
    headers: { cookie, "x-wbme-csrf-token": csrf },
  }).then(r => { console.log(r.status, r.headers.get("set-cookie")); process.exit(r.ok ? 0 : 1); })
' "<平台登录完整 Cookie>"
# 输出中 wbme_recovery_session=... 即为步骤 3/4 所需的控制 Cookie，记录备用
```

### 步骤 2：制造数据库损坏（演练限定在独立测试库或演练窗口）

> **警示**：本步骤会破坏数据，仅可在明确演练窗口内、已确认备份成功后执行。

```bash
# 停业务写入：仅保留 postgres/redis/recovery-executor，其余容器停止
docker compose --env-file .env.production stop platform-core asset hr fin worker web

# 模拟损坏：删除数据卷中的部分表文件（示例；实际按演练预设执行）
# docker compose --env-file .env.production stop postgres
# docker compose --env-file .env.production run --rm -v wbme_postgres_data:/data alpine \
#   sh -c "rm -f /data/base/*/12345"   # ← 破坏性示例，按演练预设替换
```

### 步骤 3：投递恢复清单并进入维护状态

恢复执行器保持运行（不依赖被损坏的数据库）：

```bash
INTERNAL_TOKEN="$(grep '^INTERNAL_SERVICE_TOKEN=' .env.production | cut -d= -f2-)"
# 投递恢复清单（worker 内部令牌 + 调用方白名单；body 必填 restoreUuid/backupId）
docker compose --env-file .env.production exec -T recovery-executor node -e '
  fetch("http://127.0.0.1:3090/recovery/delivery", {
    method: "POST",
    headers: { "authorization": "Bearer " + process.argv[1], "x-wbme-caller": "worker", "content-type": "application/json" },
    body: JSON.stringify({ restoreUuid: "drill-" + Date.now(), backupId: Number(process.argv[2]) }),
  }).then(r => r.json()).then(d => { console.log(JSON.stringify(d)); process.exit(d.error ? 1 : 0); })
' "$INTERNAL_TOKEN" "<backupId>"
```

> 注：`$(date +%s)` 在单引号内不会展开，改用 node 的 `Date.now()` 生成恢复 UUID；`backupId` 取步骤 1 记录值。

确认进入维护状态（控制路由在数据库不可用时仍可访问）——控制查询/触发需步骤 1.5 签发的恢复控制会话 Cookie（backstage PRD §10 人工介入通道；步骤 2 起 platform-core/web 已停止，Cookie 无法再签发），带 Cookie 调用恢复执行器控制路由：

```bash
docker compose --env-file .env.production exec -T recovery-executor node -e '
  fetch("http://127.0.0.1:3090/recovery/status", { headers: { cookie: process.argv[1] } })
    .then(r => r.json()).then(d => { console.log(JSON.stringify(d)); process.exit(d.error ? 1 : 0); })
' "wbme_recovery_session=<token>"
```

### 步骤 4：执行恢复

恢复执行器按「预检 → 维护 → 还原（OSS 清单）→ 正向迁移（Migration Runner）→ 取消任务 → 重装备份 → 清空 Redis → 就绪校验」推进；任一阶段失败保持维护状态并保存脱敏原因：

```bash
# 触发恢复（需步骤 3 签发的恢复控制 Cookie；无 Cookie → 401）
docker compose --env-file .env.production exec -T recovery-executor node -e '
  fetch("http://127.0.0.1:3090/recovery/retry", { method: "POST", headers: { cookie: process.argv[1] } })
    .then(r => r.json()).then(d => { console.log(JSON.stringify(d)); process.exit(d.error ? 1 : 0); })
' "wbme_recovery_session=<token>"

# 轮询状态直至 DONE 或 MAINTENANCE（失败保持维护；同样需 Cookie）
watch -n 5 'docker compose --env-file .env.production exec -T recovery-executor node -e \
  "fetch(\"http://127.0.0.1:3090/recovery/status\", { headers: { cookie: process.argv[1] } }).then(r=>r.json()).then(d=>console.log(JSON.stringify(d)))" \
  "wbme_recovery_session=<token>"'
```

> **READINESS 阶段时序（批次 8 就绪语义）**：恢复管道 READINESS 阶段会轮询全部应运行
> 业务服务 `/readyz`（`RESTORE_READINESS_URLS`；上限 120s，`RESTORE_BUSINESS_READY_MAX_WAIT_MS`
> 可覆盖），全部就绪才进入 DONE 退出维护。**轮询看到 stage 进入 READINESS 时立即启动业务
> 容器**——业务容器停着会让 READINESS 等满超时、恢复失败保持维护状态：

```bash
# stage 到 READINESS 即执行（等不及可在 MAINTENANCE→READINESS 切换期间提前执行）
docker compose --env-file .env.production up -d
```

### 步骤 5：恢复后校验

```bash
# 业务容器应已在步骤 4 READINESS 阶段启动（未启动则此时补启并等待就绪）：
docker compose --env-file .env.production up -d
# 校验：至少一名可用超管存在（恢复管道内已校验；此处人工确认可登录）
# 校验：发布基线重新对齐（§9.9 恢复后数据库基线 = 当前运行 commit）
cat /opt/wbme/persist/release-state/last-deployed

# 业务抽检：登录门户、查询一条业务记录、确认备份页状态与最近备份一致
```

### 步骤 6：演练清理

```bash
# 停止演练产生的维护标记与临时清单（恢复执行器正常完成即自动清理）
# 恢复发布基线若演练库未恢复则按 §9.9 手动对齐到当前运行 commit
```

## 验收判定

- [ ] 数据库损坏期间恢复执行器就绪探针仍为可访问（依赖失败仅报告，不阻断控制路由）
- [ ] 恢复完成后全部业务容器就绪，超管可登录
- [ ] 发布基线 = 当前运行 commit，下一次发布不重复收集已上线提交
- [ ] 演练全程操作日志与恢复记录可追溯
