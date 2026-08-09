# Backstage Stage 4 运维 API（T4-6 ~ T4-12）

基础路径：`/api/v1`（需登录会话 + CSRF；写操作建议携带幂等键）。

## 内容（T4-6）

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

## 数据备份与恢复（T4-7）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/backups` | `data_backup` | 备份列表 |
| POST | `/backups/immediate` | `data_backup` | 立即备份（写 IMMEDIATE_BACKUP 任务） |
| GET | `/restores` | `data_backup` | 恢复记录 |
| POST | `/restores/precheck` | `data_backup` + 超管 | 恢复预检 |
| POST | `/restores/confirm` | `data_backup` + 超管 | 确认恢复（先创建并等待恢复前紧急备份，成功后才投递 RESTORE_DELIVERY 任务） |

`/restores/confirm` 请求体：`backupId`、`idempotencyKey`、可选 `note`、可选 `proceedWithoutEmergency`（紧急备份失败时置 `true` 表示已人工确认风险后继续，backstage PRD §10 不得伪装为已有回退副本）。紧急备份与所选备份互斥（`BACKUP_LOCK_BUSY`）；等待窗口 300s，超时按失败处理、任务仍在执行时可重试继续等待（复用窗口内进行中的紧急备份）。

错误码见 contracts `backupErrors`：`RESTORE_IN_PROGRESS`、`BACKUP_LOCK_BUSY`、`EMERGENCY_BACKUP_FAILED` 等。

Worker：`apps/worker/src/processors/backup.processor.ts` 执行 `pg_dump` / OSS 上传。

## 健康状态（T4-9）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/health-status` | `health_status` | 服务探针 + 任务概览 + 磁盘 stub |

环境变量：`PLATFORM_CORE_HEALTH_URL`、`WORKER_HEALTH_URL`、`HEALTH_DISK_USAGE_RATIO`。

## 操作日志导出（T4-11）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/operation-logs/export` | `operation_log_view` | xlsx 流式导出 |

互斥键：`lock:export:{userId}`；超时 120s；超行数整次拒绝 `ROW_LIMIT_EXCEEDED`。

## 表格偏好（T4-12）

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

## 文件存储包（T4-10）

`@wbme/files`：`presignImageUpload`、`finalizeImage`、`presignBackupUpload`、`deleteObject`、`listPrefix`。

平台级图片上传/下载 HTTP 端点（platform-core）：见 `files-images.md`。

本地开发：`OSS_ACCESS_KEY_ID=change-me` 时使用 `.agents/tmp-oss/`。

## 恢复执行器（T4-8）

独立端口（默认 3010），**非** `/api/v1`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/recovery/health` | 存活 |
| GET | `/recovery/status` | 恢复状态（恢复 Cookie） |
| POST | `/recovery/retry` | 重试 |
| POST | `/recovery/delivery` | Worker 投递 RESTORE_DELIVERY（内部令牌 + `X-WBME-Caller: worker`） |
| POST | `/recovery/session` | platform-core 签发恢复 Cookie（内部令牌 + `X-WBME-Caller: platform-core`） |

`RESTORE_DRY_RUN=1` 模拟阶段（仅推进状态机）；状态目录 `RESTORE_STATE_DIR`（默认 `.agents/restore-state/`）。

恢复管道阶段（外部控制清单为唯一事实来源，原子替换写入）：PRECHECK（备份记录/校验和/对象可达）→ MAINTENANCE（维护标记 + 停写等待）→ RESTORING（下载 → SHA-256 校验 → `pg_restore --list` → `pg_restore -Fc --clean`）→ MIGRATE_FORWARD（`RECOVERY_MIGRATE_CMD` 正向迁移）→ CANCEL_TASKS（历史非终态任务标记"因整库恢复取消"）→ REINSTATE_BACKUPS（OSS 清单校验 + 幂等补回备份记录）→ CLEAR_REDIS（`flushdb`，`RECOVERY_SKIP_REDIS_FLUSH=1` 跳过）→ READINESS（迁移元数据 + 至少一名可用超管）→ DONE（退出维护）。

任一阶段失败保持维护状态并保存脱敏原因，由超管经恢复控制会话手动重试；`backstage.restores` 为镜像尽力同步（数据库可能被覆盖，失败不阻塞）。维护标记存在时 platform-core 写请求返回 503 `SYSTEM_MAINTENANCE`（应用层兜底，生产由 Nginx 只读挂载先行拦截）。pg 工具路径可经 `PG_RESTORE_PATH` 注入（macOS EDB 安装不在 PATH）。

## 迁移前备份

`PRE_MIGRATION_BACKUP_WAIT=1` → 调用 platform-core 立即备份并等待；否则回退 `PRE_MIGRATION_BACKUP_CMD`。
