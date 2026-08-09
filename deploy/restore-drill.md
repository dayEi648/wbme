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
docker compose --env-file .env.production exec -T platform-core node -e '
  fetch("http://127.0.0.1:3001/internal/v1/backups/trigger", {
    method: "POST",
    headers: { "authorization": "Bearer " + process.argv[1], "x-wbme-caller": "release-script", "content-type": "application/json" },
    body: "{}",
  }).then(r => r.json()).then(d => { console.log(JSON.stringify(d)); process.exit(d.error ? 1 : 0); })
' "$INTERNAL_TOKEN"
```

> 注：备份触发内部端点如未注册，使用管理后台页面触发（同一效果）。确认备份状态为成功后进入下一步。

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
docker compose --env-file .env.production exec -T recovery-executor node -e '
  fetch("http://127.0.0.1:3090/internal/v1/recovery/delivery", {   # 或经 worker 后台任务投递
    method: "POST",
    headers: { "authorization": "Bearer " + process.argv[1], "x-wbme-caller": "worker", "content-type": "application/json" },
    body: JSON.stringify({ restoreUuid: "drill-$(date +%s)", ... }),
  }).then(r => r.json()).then(d => { console.log(JSON.stringify(d)); process.exit(d.error ? 1 : 0); })
' "$INTERNAL_TOKEN"

# 确认进入维护状态（控制路由在数据库不可用时仍可访问）
docker compose --env-file .env.production exec -T recovery-executor node -e '
  fetch("http://127.0.0.1:3090/recovery/status").then(r => r.json()).then(d => console.log(JSON.stringify(d)))
'
```

### 步骤 4：执行恢复

恢复执行器按「预检 → 维护 → 还原（OSS 清单）→ 正向迁移（Migration Runner）→ 取消任务 → 重装备份 → 清空 Redis → 就绪校验」推进；任一阶段失败保持维护状态并保存脱敏原因：

```bash
# 触发恢复（控制会话 Cookie 由 platform-core 超管签发；演练可经 recovery/session 签发）
docker compose --env-file .env.production exec -T recovery-executor node -e '
  fetch("http://127.0.0.1:3090/recovery/retry", { method: "POST" })
    .then(r => r.json()).then(d => { console.log(JSON.stringify(d)); process.exit(d.error ? 1 : 0); })
'

# 轮询状态直至 DONE 或 MAINTENANCE（失败保持维护）
watch -n 5 'docker compose --env-file .env.production exec -T recovery-executor node -e \
  "fetch(\"http://127.0.0.1:3090/recovery/status\").then(r=>r.json()).then(d=>console.log(JSON.stringify(d)))"'
```

### 步骤 5：恢复后校验

```bash
# 业务容器恢复启动并等待就绪
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
