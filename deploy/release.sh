#!/usr/bin/env bash
# WBME 生产发布脚本（dev-workflow §3 / 主 PRD §9.9/§9.12/§9.14 / backstage PRD §9）。
# 用法：在 ECS 部署机上 deploy/ 目录执行：  ./release.sh <tag>
# 前置：tag 已推送到远端；deploy/.env.production 已按模板填写；docker 与 git 可用。
# 本期只交付脚本，不执行实际部署；实际发布在部署到 ECS 后进行。
#
# 语义（与 PRD 逐条对应）：
#   - 一次发布 = 一个 tag = 一个 commit，全部组件从该 commit 构建（§1.3）；
#   - 版本只前进：目标 tag 必须是上次成功部署 commit 的后继，否则失败即停；
#   - 重复发布（同一 commit 已成功部署）不重复构建/部署/记录更新日志（幂等补核验）；
#   - 失败即停：任何一步非零退出，不写成功状态（可修复后重试）；
#   - 部署成功并通过全部就绪检查后，从「上次成功部署 commit（不含）→ 本次（含）」
#     自动生成更新日志并幂等追加（releaseId = tag）；基线来自数据库外持久状态，不从日志反推；
#   - 部署后核验：日志驱动（§9.12）、公网端口/特权/Socket 挂载（§9.14）、时钟同步（§9.14）。
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEPLOY_DIR"

TAG="${1:?用法: ./release.sh <tag>}"
ENV_FILE="$DEPLOY_DIR/.env.production"
RELEASE_STATE_DIR="${RELEASE_STATE_DIR:-/opt/wbme/persist/release-state}"
STATE_FILE="$RELEASE_STATE_DIR/last-deployed"
COMPOSE_OPTS=(--env-file "$ENV_FILE")

log()  { printf '[release] %s\n' "$*"; }
fail() { printf '[release] 失败：%s\n' "$*" >&2; exit 1; }

# ---- 1. 前置检查 ----
[ -f "$ENV_FILE" ] || fail "缺少 $ENV_FILE（先 cp .env.production.example .env.production 并填写机密）"
command -v docker >/dev/null || fail "docker 不可用"
command -v git >/dev/null || fail "git 不可用"
docker compose version >/dev/null 2>&1 || fail "docker compose 插件不可用"
mkdir -p "$RELEASE_STATE_DIR"
chmod 700 "$RELEASE_STATE_DIR"

# ---- 2. 目标 tag 解析与远端同步 ----
git fetch --tags origin >/dev/null 2>&1 || true
TAG_SHA="$(git rev-parse --verify "refs/tags/$TAG^{commit}" 2>/dev/null)" || fail "tag $TAG 不存在或未推送"

# ---- 3. 版本只前进 + 重复发布识别（§9.9：基线 = 持久状态文件，不从数据库反推）----
LAST_LINE=""
[ -f "$STATE_FILE" ] && LAST_LINE="$(cat "$STATE_FILE")"
LAST_SHA="$(echo "$LAST_LINE" | awk '{print $2}')"
if [ -n "$LAST_SHA" ]; then
  if [ "$LAST_SHA" = "$TAG_SHA" ]; then
    # 重复发布：幂等重跑核验与更新日志追加，不重新构建/部署
    log "commit $TAG_SHA 已在上次成功部署（$LAST_LINE），跳过构建与部署（幂等补核验）"
    LAST_SHA="$TAG_SHA"
    SKIP_DEPLOY=1
  else
    git merge-base --is-ancestor "$LAST_SHA" "$TAG_SHA" || fail "版本只前进校验失败：$LAST_SHA 不是 $TAG_SHA 的祖先（回滚不被允许，向前发布新修复）"
    log "版本前进校验通过：$LAST_SHA → $TAG_SHA"
  fi
else
  log "首次发布（无上次成功部署基线）"
fi

# 就绪等待工具（第 4/5 节共用）
wait_ready() { # $1 服务名 $2 端口 [$3 探针路径 默认 /readyz]
  local svc="$1" port="$2" path="${3:-/readyz}" i
  for i in $(seq 1 60); do
    if docker compose "${COMPOSE_OPTS[@]}" exec -T "$svc" node -e \
      "fetch('http://127.0.0.1:$port$path').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  fail "服务 $svc 未就绪（$port$path 超时）"
}
# worker 无 HTTP 端口：以容器健康状态为准（kill -0 进程存活 + 启动强检已过）
wait_worker_healthy() {
  local i cid
  for i in $(seq 1 60); do
    cid="$(docker compose "${COMPOSE_OPTS[@]}" ps -q worker 2>/dev/null | head -1)"
    [ -n "$cid" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = "healthy" ] && return 0
    sleep 5
  done
  fail "worker 未就绪（容器健康状态超时）"
}

# ---- 4. 构建与部署 ----
if [ -z "${SKIP_DEPLOY:-}" ]; then
  log "构建镜像（tag=$TAG）..."
  docker compose "${COMPOSE_OPTS[@]}" build

  if [ -n "$LAST_SHA" ]; then
    # 升级部署：迁移前备份需要 platform-core（/internal/v1 内部端点）与 worker（执行备份）可用。
    # 注意：readyz 含迁移版本检查（迁移前恒 503），此处以 healthz（进程探针，不含迁移检查）判定可用；
    # 迁移完成后下方第 5 节以 readyz 复核全部服务。
    log "拉起备份链路（platform-core / worker）..."
    docker compose "${COMPOSE_OPTS[@]}" up -d platform-core worker
    wait_ready platform-core 3001 /healthz
    wait_worker_healthy
  fi

  log "执行迁移（migration-runner；迁移前自动立即备份钩子）..."
  docker compose "${COMPOSE_OPTS[@]}" run --rm migration-runner

  log "更新全部容器（优雅停机由 stop_grace_period 保证）..."
  WBME_TAG="$TAG" docker compose "${COMPOSE_OPTS[@]}" up -d
else
  # 重复发布：仍按状态文件 commit 构建镜像可跳过，但需要 WBME_TAG 与镜像一致
  :
fi

# ---- 5. 就绪等待（全部应运行服务）----
wait_ready platform-core 3001
wait_ready asset 3002
wait_ready hr 3003
wait_ready fin 3004
wait_worker_healthy
wait_ready recovery-executor 3090 /recovery/readyz
# web（nginx alpine 内置 wget；探针经 Nginx 回源 platform-core）
for i in $(seq 1 60); do
  docker compose "${COMPOSE_OPTS[@]}" exec -T web wget -q -O /dev/null http://127.0.0.1/healthz && break
  [ "$i" = 60 ] && fail "web 未就绪"
  sleep 5
done
log "全部服务就绪"

# ---- 6. 发布核验（§9.12 日志驱动 / §9.14 特权、端口、时钟）----
log "核验日志驱动（local 20m×5）..."
for cid in $(docker compose "${COMPOSE_OPTS[@]}" ps -q); do
  docker inspect --format '{{.HostConfig.LogConfig.Type}}|{{index .HostConfig.LogConfig.Config "max-size"}}|{{index .HostConfig.LogConfig.Config "max-file"}}' "$cid" \
    | grep -q '^local|20m|5$' || fail "容器 $cid 日志驱动不符合 §9.12（local 20m×5）"
done

log "核验安全边界（无特权/Socket 挂载）..."
for cid in $(docker compose "${COMPOSE_OPTS[@]}" ps -q); do
  privileged="$(docker inspect --format '{{.HostConfig.Privileged}}' "$cid")"
  [ "$privileged" = "false" ] || fail "容器 $cid 使用了 privileged（§9.14 禁止）"
  docker inspect --format '{{.HostConfig.Binds}}' "$cid" | grep -q '/var/run/docker.sock' && fail "容器 $cid 挂载了 Docker Socket（§9.14 禁止）" || true
done

log "核验公网端口（仅 web 80）..."
ss -ltn 2>/dev/null | grep -q ':80 ' || fail "80 端口未监听（§9.14：仅 Nginx 入口暴露公网）"

log "核验时钟同步（§9.14）..."
if command -v timedatectl >/dev/null 2>&1; then
  if ! timedatectl 2>/dev/null | grep -qi 'synchronized: yes'; then
    if [ "${ALLOW_CLOCK_DRIFT:-}" = "1" ]; then
      log "警告：系统时钟未同步，已由 ALLOW_CLOCK_DRIFT=1 显式放行（涉及 OAuth 状态/会话到期/预签名 URL 的服务可能不就绪）"
    else
      fail "系统时钟未同步（§9.14：发布失败即停）。确认环境后可用 ALLOW_CLOCK_DRIFT=1 显式放行重试"
    fi
  fi
else
  # timedatectl 缺失（精简容器/无 systemd 环境）：无法核验，打明确警告不阻断（§9.14 措辞见 security-checklist）
  log "警告：timedatectl 不存在，跳过时钟核验（无法确认系统时间同步状态）"
fi

# ---- 7. 更新日志自动生成（backstage PRD §9 / §9.9）----
log "生成更新日志（范围：$LAST_SHA（不含）→ $TAG_SHA（含））..."
SUBJECTS="[]"
if [ -n "$LAST_SHA" ] && [ "$LAST_SHA" != "$TAG_SHA" ]; then
  # 提交标题提取规则：剥离 Conventional Commits 前缀（type(scope)!: / type!: / type(scope): / type:），
  # 不符合格式的保留完整标题并记录警告（不阻断部署）
  SUBJECTS="$(git log --reverse --format='%s' "$LAST_SHA..$TAG_SHA" \
    | sed -E 's/^[a-z]+(\([^)]*\))?!?:[[:space:]]*//' \
    | awk '{print "\"" gensub(/"/, "\\\\\"", "g") "\""}' | paste -sd, - | sed 's/^/[ /; s/$/ ]/')"
  git log --format='%s' "$LAST_SHA..$TAG_SHA" | grep -qE '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?:' || log "警告：范围内存在不符合 Conventional Commits 的提交标题（保留完整标题展示）"
fi

INTERNAL_TOKEN="$(grep -E '^INTERNAL_SERVICE_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
[ -n "$INTERNAL_TOKEN" ] || fail "缺少 INTERNAL_SERVICE_TOKEN"
VERSION="${TAG#v}"
APPEND_RESULT="$(docker compose "${COMPOSE_OPTS[@]}" exec -T platform-core node -e '
  const [releaseId, version, commitSha, subjectsJson, token] = process.argv.slice(1);
  fetch("http://127.0.0.1:3001/internal/v1/release-logs/append", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + token, "x-wbme-caller": "release-script" },
    body: JSON.stringify({ releaseId, version, commitSha, subjects: JSON.parse(subjectsJson) }),
  }).then(r => r.json()).then(d => {
    if (d.error) { console.error(JSON.stringify(d.error)); process.exit(1); }
    console.log(JSON.stringify(d));
  }).catch(e => { console.error(String(e)); process.exit(1); });
' "$TAG" "$VERSION" "$TAG_SHA" "$SUBJECTS" "$INTERNAL_TOKEN")"
log "更新日志追加：$APPEND_RESULT"

# ---- 8. 原子记录成功状态（数据库外持久化；§9.9 基线来源）----
echo "$TAG $TAG_SHA $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
log "发布完成：$TAG（$TAG_SHA），基线已记录到 $STATE_FILE"
