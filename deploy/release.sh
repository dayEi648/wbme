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
# 恢复执行器状态目录（compose 的 RESTORE_STATE_DIR 硬编码值）：容器以非 root
# uid 运行（Dockerfile USER wbme = 10001），bind mount 自动创建的宿主目录为
# root:root，会使 readyz 写探针 EACCES → 首次发布卡死，部署前置预建并移交属主
RESTORE_STATE_DIR="${RESTORE_STATE_DIR:-/opt/wbme/persist/restore-state}"
RECOVERY_EXECUTOR_UID="${RECOVERY_EXECUTOR_UID:-10001}"
COMPOSE_OPTS=(--env-file "$ENV_FILE")

log()  { printf '[release] %s\n' "$*"; }
fail() { printf '[release] 失败：%s\n' "$*" >&2; exit 1; }

# ---- 1. 前置检查 ----
[ -f "$ENV_FILE" ] || fail "缺少 $ENV_FILE（先 cp .env.production.example .env.production 并填写机密）"
command -v docker >/dev/null || fail "docker 不可用"
command -v git >/dev/null || fail "git 不可用"
docker compose version >/dev/null 2>&1 || fail "docker compose 插件不可用"
# 配置合法性校验（§9.12）：compose + env 解析失败立即停止，不进入构建；
# 不重定向 stderr，失败时保留 docker 的具体错误原因
if ! docker compose "${COMPOSE_OPTS[@]}" config --quiet >/dev/null; then
  fail "docker compose 配置校验失败（上方为具体错误；检查 .env.production 与 docker-compose.yml）"
fi
# TLS 证书前置检查（§9.14 HTTPS）：nginx 443 强制 HTTPS，证书缺失 web 容器起不来，
# 会在就绪等待 5 分钟超时后才发现——前置 fail 并提示放置位置
TLS_CERT_DIR="${TLS_CERT_DIR:-$(grep -E '^TLS_CERT_DIR=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)}"
TLS_CERT_DIR="${TLS_CERT_DIR:-/opt/wbme/tls}"
[ -f "$TLS_CERT_DIR/fullchain.pem" ] || fail "缺少 TLS 证书 $TLS_CERT_DIR/fullchain.pem（§9.14：部署前放置 fullchain.pem 与 privkey.pem 到 TLS_CERT_DIR）"
[ -f "$TLS_CERT_DIR/privkey.pem" ] || fail "缺少 TLS 私钥 $TLS_CERT_DIR/privkey.pem（§9.14：部署前放置 fullchain.pem 与 privkey.pem 到 TLS_CERT_DIR）"
mkdir -p "$RELEASE_STATE_DIR"
chmod 700 "$RELEASE_STATE_DIR"
mkdir -p "$RESTORE_STATE_DIR"
chown "$RECOVERY_EXECUTOR_UID:$RECOVERY_EXECUTOR_UID" "$RESTORE_STATE_DIR"
chmod 700 "$RESTORE_STATE_DIR"

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
# worker 业务无 HTTP 端口（L37 起仅健康探针 43105 供健康状态页探测）；
# 发布等待以容器健康状态为准（kill -0 进程存活 + 启动强检已过）
wait_worker_healthy() {
  local i cid
  for i in $(seq 1 60); do
    cid="$(docker compose "${COMPOSE_OPTS[@]}" ps -q worker 2>/dev/null | head -1)"
    [ -n "$cid" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = "healthy" ] && return 0
    sleep 5
  done
  fail "worker 未就绪（容器健康状态超时）"
}

# 发布前已主动停用的服务清单（第 4 节填充；顶层初始化保证 set -u 下第 5 节安全展开）
STOPPED_BEFORE=()
# $1 服务名；发布前已停用则返回 0（第 5 节就绪等待据此跳过，保持运维停用状态）
# ${arr[@]+...} 写法兼容空数组 + set -u（bash 3.2 空数组直接展开会报 unbound）
is_stopped_before() {
  local svc="$1" s
  for s in ${STOPPED_BEFORE[@]+"${STOPPED_BEFORE[@]}"}; do
    [ "$s" = "$svc" ] && return 0
  done
  return 1
}

# ---- 4. 构建与部署 ----
if [ -z "${SKIP_DEPLOY:-}" ]; then
  # L35：统一构建/启动镜像 tag（compose image 为 wbme/backend:${WBME_TAG:-local}），
  # 避免 build 打 :local、up -d 用 :$TAG 触发二次构建
  export WBME_TAG="$TAG"
  log "构建镜像（tag=$TAG）..."
  docker compose "${COMPOSE_OPTS[@]}" build

  if [ -n "$LAST_SHA" ]; then
    # 升级部署：迁移前备份需要 platform-core（/internal/v1 内部端点）与 worker（执行备份）可用。
    # 注意：readyz 含迁移版本检查（迁移前恒 503），此处以 healthz（进程探针，不含迁移检查）判定可用；
    # 迁移完成后下方第 5 节以 readyz 复核全部服务。
    log "拉起备份链路（platform-core / worker）..."
    docker compose "${COMPOSE_OPTS[@]}" up -d platform-core worker
    wait_ready platform-core 43001 /healthz
    wait_worker_healthy
  fi

  log "执行迁移（migration-runner；迁移前自动立即备份钩子）..."
  docker compose "${COMPOSE_OPTS[@]}" run --rm migration-runner

  # 记录发布前主动停用的常驻服务（主 PRD §1.3：停止状态业务服务不被强制启动）
  # migration-runner 为一次性容器，不参与记录；仅记录有容器且状态非 running 的服务。
  # 必须加 --all/-a：docker compose ps 默认只列 running 容器，docker compose stop 后的
  # exited 容器不可见，不加则 STOPPED_BEFORE 恒为空、重新 stop 逻辑成为死代码
  for svc in $(docker compose "${COMPOSE_OPTS[@]}" ps --all --services 2>/dev/null | grep -v '^migration-runner$'); do
    cid="$(docker compose "${COMPOSE_OPTS[@]}" ps -aq "$svc" 2>/dev/null | head -1)"
    if [ -n "$cid" ]; then
      state="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null)"
      if [ "$state" != "running" ]; then
        STOPPED_BEFORE+=("$svc")
      fi
    fi
  done

  log "更新全部容器（优雅停机由 stop_grace_period 保证）..."
  docker compose "${COMPOSE_OPTS[@]}" up -d

  # 恢复发布前主动停用的服务（保持运维停用状态，主 PRD §1.3）
  if [ ${#STOPPED_BEFORE[@]} -gt 0 ]; then
    for svc in "${STOPPED_BEFORE[@]}"; do
      docker compose "${COMPOSE_OPTS[@]}" stop "$svc" 2>/dev/null || true
      log "保持运维主动停用状态：$svc（主 PRD §1.3）"
    done
  fi
else
  # 重复发布：仍按状态文件 commit 构建镜像可跳过，但需要 WBME_TAG 与镜像一致
  :
fi

# ---- 5. 就绪等待（全部应运行服务；发布前已主动停用的服务跳过探测，否则等满超时必然发布失败）----
wait_ready_running() { # $1 服务名 $2 端口 [$3 探针路径 默认 /readyz]
  if is_stopped_before "$1"; then
    log "跳过就绪探测：$1（发布前已停用，保持停用状态，主 PRD §1.3）"
    return 0
  fi
  wait_ready "$@"
}
wait_ready_running platform-core 43001
wait_ready_running asset 43002
wait_ready_running hr 43003
wait_ready_running fin 43004
if is_stopped_before worker; then
  log "跳过就绪探测：worker（发布前已停用，保持停用状态，主 PRD §1.3）"
else
  wait_worker_healthy
fi
wait_ready_running recovery-executor 43090 /recovery/readyz
# web（nginx alpine 内置 wget；探针经 Nginx 回源 platform-core）
if is_stopped_before web; then
  log "跳过就绪探测：web（发布前已停用，保持停用状态，主 PRD §1.3）"
else
  for i in $(seq 1 60); do
    docker compose "${COMPOSE_OPTS[@]}" exec -T web wget -q -O /dev/null http://127.0.0.1/healthz && break
    [ "$i" = 60 ] && fail "web 未就绪"
    sleep 5
  done
fi
log "全部应运行服务就绪"

# ---- 6. 发布核验（§9.12 日志驱动 / §9.14 特权、端口、时钟）----
log "核验日志驱动（local 20m×5+compress）..."
for cid in $(docker compose "${COMPOSE_OPTS[@]}" ps -q); do
  # L33：运行期核验补 compress 标志（compose 配置 local 20m×5+compress，见 §9.12）
  docker inspect --format '{{.HostConfig.LogConfig.Type}}|{{index .HostConfig.LogConfig.Config "max-size"}}|{{index .HostConfig.LogConfig.Config "max-file"}}|{{index .HostConfig.LogConfig.Config "compress"}}' "$cid" \
    | grep -q '^local|20m|5|true$' || fail "容器 $cid 日志驱动不符合 §9.12（local 20m×5 compress）"
done

log "核验安全边界（无特权/Socket 挂载）..."
for cid in $(docker compose "${COMPOSE_OPTS[@]}" ps -q); do
  privileged="$(docker inspect --format '{{.HostConfig.Privileged}}' "$cid")"
  [ "$privileged" = "false" ] || fail "容器 $cid 使用了 privileged（§9.14 禁止）"
  docker inspect --format '{{.HostConfig.Binds}}' "$cid" | grep -q '/var/run/docker.sock' && fail "容器 $cid 挂载了 Docker Socket（§9.14 禁止）" || true
done

log "核验数据卷持久化（命名卷 postgres_data / redis_data，§9.13）..."
docker volume inspect wbme_postgres_data >/dev/null 2>&1 \
  || fail "命名卷 wbme_postgres_data 不存在（§9.13：正式数据须在命名卷）"
docker volume inspect wbme_redis_data >/dev/null 2>&1 \
  || fail "命名卷 wbme_redis_data 不存在（§9.13）"

log "核验公网端口（web 80/443 应监听，5432/6379/43090 不得暴露公网，§9.14）..."
if command -v ss >/dev/null 2>&1; then
  # ss -ltnH 输出无表头（LISTEN Recv-Q Send-Q Local Address:Port Peer Address:Port），
  # Local Address:Port 在第 4 列——必须按列匹配；行首锚定 ^(0.0.0.0|::):port 匹配的是
  # 行首的 LISTEN 状态列，永不命中（曾导致暴露漏报）
  for port in 80 443; do
    ss -ltnH 2>/dev/null | awk -v port="$port" '$4 ~ ":" port "$" { found = 1 } END { exit(found ? 0 : 1) }' \
      || fail "$port 端口未监听（§9.14：仅 Nginx 入口 80/443 暴露公网）"
  done
  # 5432（PG）/6379（Redis）/43090（恢复执行器）不得监听在非回环地址（127.0.0.0/8 回环允许）
  for port in 5432 6379 43090; do
    if ss -ltnH 2>/dev/null | awk -v port="$port" '$4 ~ ":" port "$" && $4 !~ /^127\./ { found = 1 } END { exit(found ? 0 : 1) }'; then
      fail "端口 $port 监听在非回环地址（§9.14：仅 80/443 暴露公网，业务端口应仅在容器网络）"
    fi
  done
else
  log "警告：未找到 ss（iproute2 未安装），跳过公网端口核验（§9.14 建议安装 iproute2 以启用该检查）"
fi

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
  fetch("http://127.0.0.1:43001/internal/v1/release-logs/append", {
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
