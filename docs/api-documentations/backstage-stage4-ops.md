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
| POST | `/restores/confirm` | `data_backup` + 超管 | 确认恢复（RESTORE_DELIVERY 任务） |

错误码见 contracts `backupErrors`：`RESTORE_IN_PROGRESS`、`BACKUP_LOCK_BUSY` 等。

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

本地开发：`OSS_ACCESS_KEY_ID=change-me` 时使用 `.agents/tmp-oss/`。

## 恢复执行器（T4-8）

独立端口（默认 3010），**非** `/api/v1`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/recovery/health` | 存活 |
| GET | `/recovery/status` | 恢复状态（恢复 Cookie） |
| POST | `/recovery/retry` | 重试 |
| POST | `/recovery/delivery` | Worker 投递 RESTORE_DELIVERY |
| POST | `/recovery/session` | 签发恢复 Cookie |

`RESTORE_DRY_RUN=1` 模拟阶段；状态目录 `RESTORE_STATE_DIR`（默认 `.agents/restore-state/`）。

## 迁移前备份

`PRE_MIGRATION_BACKUP_WAIT=1` → 调用 platform-core 立即备份并等待；否则回退 `PRE_MIGRATION_BACKUP_CMD`。
