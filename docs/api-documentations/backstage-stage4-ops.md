# Backstage Stage 4 运维 API

基础路径：`/api/v1`（需登录会话 + CSRF；写操作建议携带幂等键）。

## 内容

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/release-logs` | `release_log_view` | 分页列出更新日志 |
| GET | `/release-logs/for-announcement` | `announcement_manage` | 公告管理员复制来源 |
| GET | `/announcements` | `announcement_manage` | 公告列表 |
| POST | `/announcements` | `announcement_manage` | 创建草稿 |
| PUT | `/announcements/:id` | `announcement_manage` | 编辑 |
| POST | `/announcements/:id/publish` | `announcement_manage` | 发布（事务内撤回当前展示） |
| POST | `/announcements/:id/revoke` | `announcement_manage` | 撤回 |
| DELETE | `/announcements/batch` | `announcement_manage` | 批量软删除 |

`appendReleaseLog({ releaseId, version, commitSha, subjects })` 由部署脚本调用 `ReleaseLogService`，`releaseId` 唯一。

## 数据备份与恢复

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/backups` | `data_backup` | 备份列表 |
| POST | `/backups/immediate` | `data_backup` | 立即备份（写 IMMEDIATE_BACKUP 任务） |
| GET | `/restores` | `data_backup` | 恢复记录 |
| POST | `/restores/precheck` | `data_backup` + 超管 | 恢复预检（普通备份运行中返回预检等待状态） |
| POST | `/restores/confirm` | `data_backup` + 超管 | 确认恢复（先创建并等待恢复前紧急备份，成功后才投递 RESTORE_DELIVERY 任务） |

`/restores/precheck` 请求体：`backupId`。普通（定时/立即）备份运行中返回 `{ ready: false, waitingForBackup: true, runningBackupId }`，前端停留在预检等待并轮询本接口直到放行（backstage PRD §10，不拒绝、不并发 pg_dump）；放行后返回 `{ ready: true, backupTime, fileSize, checksum, pgVersion }`。

`/restores/confirm` 请求体：`backupId`、`idempotencyKey`、可选 `note`、可选 `proceedWithoutEmergency`（紧急备份失败时置 `true` 表示已人工确认风险后继续，backstage PRD §10 不得伪装为已有回退副本）。普通备份运行中的防御性检查仍返回 `BACKUP_LOCK_BUSY`（正常流程由预检等待保证不触发）；紧急备份等待窗口 300s，超时按失败处理、任务仍在执行时可重试继续等待（复用窗口内进行中的紧急备份）。该路由使用独立 330s 路由级超时（Nginx 精确匹配路由读超时 360s），避免被全局 30s HTTP 超时截断。

错误码见 contracts `backupErrors`：`RESTORE_IN_PROGRESS`、`BACKUP_LOCK_BUSY`、`EMERGENCY_BACKUP_FAILED` 等。

Worker：`apps/worker/src/processors/backup.processor.ts` 执行 `pg_dump` / OSS 上传。

## 健康状态

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/health-status` | `health_status` | 服务探针 + 任务概览（含按模块+类型的 failed24h/lastFailureAt）+ 真实磁盘使用率 |

环境变量（注入 platform-core）：

| 变量 | 说明 |
| --- | --- |
| `PLATFORM_CORE_HEALTH_URL` / `ASSET_HEALTH_URL` / `HR_HEALTH_URL` / `FIN_HEALTH_URL` / `WORKER_HEALTH_URL` / `RECOVERY_EXECUTOR_HEALTH_URL` | 各部署单元探针基址（追加 `/healthz`、`/readyz`） |
| `HEALTH_DISK_STATUS_URL` / `DISK_STATUS_CALLER` | platform-core、fin、Worker 调用恢复执行器的受令牌保护聚合磁盘探针；调用方固定为部署单元名 |
| `HEALTH_DISK_PATHS` | 仅注入 recovery-executor，固定为 PostgreSQL 数据卷、Redis 数据卷与恢复状态目录的只读挂载点 |
| `HEALTH_DISK_WARN_RATIO` / `HEALTH_DISK_CRITICAL_RATIO` | 预警/严重阈值（默认 0.8 / 0.9） |

磁盘达严重阈值时，平台拒绝新的图片上传、Excel 导入与备份任务（`DISK_SPACE_CRITICAL`，主 PRD §9.13）；任一目标卷无法测量时健康页显示严重且容量型写入返回 `DEPENDENCY_UNAVAILABLE`，不会按正常状态放行。

## 操作日志导出

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/operation-logs/export` | `operation_log_view` | xlsx 流式导出（筛选参数与列表一致，含 `departmentId`） |

互斥键：`lock:export:{userId}`；超时 120s；超行数整次拒绝 `ROW_LIMIT_EXCEEDED`。

## 表格偏好

账号作用域，仅需登录：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me/table-prefs/:pageKey/filter-presets` | 筛选预设列表 |
| POST | `/me/table-prefs/:pageKey/filter-presets` | 创建预设 |
| PUT | `/me/table-prefs/filter-presets/:id` | 更新预设内容 |
| PUT | `/me/table-prefs/filter-presets/:id/name` | 重命名 |
| DELETE | `/me/table-prefs/filter-presets/:id` | 物理删除 |
| GET | `/me/table-prefs/:pageKey/column-setting` | 列设置 |
| PUT | `/me/table-prefs/:pageKey/column-setting` | 保存列设置 |

## 文件存储包

`@wbme/files`：`presignImageUpload`、`finalizeImage`、`presignBackupUpload`、`deleteObject`、`listPrefix`。

平台级图片上传/下载 HTTP 端点（platform-core）：见 `files-images.md`。

本地开发：`OSS_ACCESS_KEY_ID=change-me` 时使用 `.agents/tmp-oss/`。

## 恢复执行器

独立端口（默认 43090，与执行器 `RECOVERY_EXECUTOR_PORT` 默认一致），**非** `/api/v1`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/recovery/health` | 存活摘要 |
| GET | `/recovery/healthz` | 存活探针（免登录恒 200，Docker/Nginx 使用） |
| GET | `/recovery/readyz` | 就绪探针（免登录；状态目录读写 + 控制配置完整，否则 503） |
| GET | `/recovery/disk` | 聚合磁盘状态（内部令牌；仅 platform-core / fin / worker） |
| GET | `/recovery/status` | 恢复状态（恢复 Cookie） |
| POST | `/recovery/retry` | 重试 |
| POST | `/recovery/delivery` | Worker 投递 RESTORE_DELIVERY（内部令牌 + `X-WBME-Caller: worker`） |
| POST | `/recovery/session` | platform-core 签发恢复 Cookie（内部令牌 + `X-WBME-Caller: platform-core`） |

`RESTORE_DRY_RUN=1` 模拟阶段（仅推进状态机）；状态目录 `RESTORE_STATE_DIR`（默认 `.agents/restore-state/`）。

恢复管道阶段（外部控制清单为唯一事实来源，原子替换写入）：PRECHECK（备份记录/校验和/对象可达/SSE-OSS/AES256 加密元数据/PG 大版本兼容）→ MAINTENANCE（维护标记 + 停写等待：全部 client backend 连接含 idle 排空）→ RESTORING（流式下载 → SHA-256 校验 → `pg_restore --list` → `pg_restore -Fc --clean`）→ MIGRATE_FORWARD（`RECOVERY_MIGRATE_CMD` 正向迁移）→ CANCEL_TASKS（历史非终态任务标记"因整库恢复取消"）→ REINSTATE_BACKUPS（OSS 清单 + 对象大小/SHA-256/`pg_restore --list` 校验 + 幂等补回备份记录）→ CLEAR_REDIS（`flushdb`，`RECOVERY_SKIP_REDIS_FLUSH=1` 跳过）→ READINESS（迁移元数据 + 至少一名可用超管 + `RESTORE_READINESS_URLS` 全部应运行业务服务 `/readyz` 就绪）→ DONE（退出维护）。

任一阶段失败保持维护状态并保存脱敏原因，由超管经恢复控制会话手动重试；`backstage.restores` 为镜像尽力同步（数据库可能被覆盖，失败不阻塞）。维护标记存在时 Nginx 对业务页面与 API 先行返回 503，仅额外放行健康探针与恢复控制路由 `/recovery/`（浏览器携带恢复控制会话 Cookie 访问 `GET /recovery/status` / `POST /recovery/retry`；Cookie 为 `Path=/recovery` 的受限 HttpOnly Cookie，由超管在停止服务前经 `POST /api/v1/restores/session` 签发；非维护状态 `/recovery/` 一律 404）；platform-core、asset、hr、fin 的应用层对除 `/healthz`、`/readyz` 外的全部请求返回 `SYSTEM_MAINTENANCE`，Worker 也停止投递新任务。pg 工具路径可经 `PG_RESTORE_PATH` 注入（macOS EDB 安装不在 PATH）。

## 迁移前备份

`PRE_MIGRATION_BACKUP_WAIT=1` → 调用 platform-core 内部端点并等待成功；否则回退 `PRE_MIGRATION_BACKUP_CMD` 命令行逃生通道。

### 内部备份端点（主 PRD §9.4）

仅供 `migration-runner` 使用（`Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` + `X-WBME-Caller: migration-runner`），不暴露公网：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/internal/v1/backups/immediate` | 触发立即备份（与公开端点共享互斥锁与恢复清单拒绝逻辑） |
| GET | `/internal/v1/backups/immediate/status/:backupId` | 查询备份状态（轮询用） |
