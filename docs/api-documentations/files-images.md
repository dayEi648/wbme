# 平台图片上传与下载 API

基础路径：`/api/v1`（需登录会话 + CSRF）。

图片上传采用「预签名直传 + 后端正式化」两段式（主 PRD §9.2）：客户端先获取限时预签名 PUT URL 直传**临时对象**（私有桶，不可公网访问），业务保存时由后端校验、重编码为**正式对象**后才被业务记录引用；未关联业务记录且超过保留期（默认 24h，系统设置可调）的临时对象由 Worker 定期物理清理。

上传者权限：三个端点均仅要求登录（平台通用能力）；**业务场景功能权限**（如资产主图 `asset_*`）由引用该图片的业务保存接口守卫校验，不在本服务重复校验。

限流（主 PRD §9.7，均可经 `RATE_LIMIT_<PREFIX>_LIMIT` / `_WINDOW_SECONDS` 覆盖）：

| 端点 | 维度 | 默认 |
| --- | --- | --- |
| presign | 用户 / IP | 60/min · 120/min（`IMAGE_PRESIGN` / `IMAGE_PRESIGN_IP`） |
| finalize | 用户 | 60/min（`IMAGE_FINALIZE`） |
| download | 用户 / IP | 120/min · 240/min（`IMAGE_DOWNLOAD` / `IMAGE_DOWNLOAD_IP`） |

磁盘达严重阈值时 `presign`/`finalize` 返回 `DISK_SPACE_CRITICAL`（主 PRD §9.13）。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/files/images/presign` | 生成图片上传预签名 PUT URL（临时对象） |
| POST | `/files/images/finalize` | 校验并重编码临时对象为正式对象（仅限本人临时对象） |
| GET | `/files/images/download` | 正式图片对象限时下载 URL（预签名 GET，有效期 300s） |

## POST /files/images/presign

请求体：

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `originalFilename` | string | 可选，≤255 字符 | 原始文件名（**仅**用于扩展名提示；服务端不信任文件名/扩展名/MIME） |

响应：`{ objectKey, uploadUrl, expiresAt, localPath? }`。`uploadUrl` 为限时（300s）预签名 PUT 地址，客户端以 `PUT` + `Content-Type: application/octet-stream` 直传（签名含该请求头，缺失会被 OSS 拒绝）；`localPath` 仅本地开发替身（`.agents/tmp-oss/`）返回。

对象键由服务端生成并**按用户隔离**：`images/{userId}/{uuid}{ext}`。

错误码：`VALIDATION_FAILED`（文件名过长）。

## POST /files/images/finalize

请求体：

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `pendingObjectKey` | string | ≤512 字符，必须属于当前用户 | 客户端已上传的临时对象键 |

服务端读取临时对象 → magic bytes 校验格式（仅 JPEG/PNG/WebP，拒绝 SVG/GIF/脚本化内容）→ 体积上限 1MB → sharp 完整解码、纠正方向、剥离 EXIF 后重编码 → 覆盖写回正式对象（同键）。

响应：`{ objectKey, mime, size }`。返回的 `objectKey` 供业务记录引用。

错误码：`VALIDATION_FAILED`（键不属于当前用户 / 格式不合法 / 超过体积上限）、`DISK_SPACE_CRITICAL`（磁盘严重阈值）。

## GET /files/images/download

查询参数：

| 参数 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `objectKey` | string | ≤512 字符，`images/{userId}/{uuid}{ext}` 结构 | 正式图片对象键 |

响应：`{ objectKey, downloadUrl, expiresAt, localPath? }`。`downloadUrl` 为限时（300s）预签名 GET 地址，前端直接用作 `<img src>` 或 `fetch`。

安全边界：仅接受 `images/` 前缀且结构匹配服务端生成规则的对象键；`backups/` 等其它前缀一律拒绝（主 PRD §9.2「数据库备份不通过普通业务文件下载通道暴露」）。临时对象在正式化前不存在业务引用，因此无合法渠道获得其 GET 凭证。

错误码：`VALIDATION_FAILED`（结构不合法）。

## 错误与日志

- 本组端点不写操作日志（非业务增删改）；业务保存接口在引用正式对象时随业务事务记录操作日志。
- 上传成功仅产生临时对象；业务保存失败或未保存时由 Worker 图片清理任务按保留期删除（`UNASSOCIATED_IMAGE_CLEANUP`）。
- 已关联、被历史记录引用或业务记录仅软删除的图片不得被清理；更换主图时旧图作为变更历史引用继续保留。

## 本地开发

`OSS_ACCESS_KEY_ID=change-me`（或未配置）时使用本地替身：预签名 URL 为 `file://` 路径，上传写入 `.agents/tmp-oss/images/`；`downloadUrl` 同理返回本地路径。

相关共享包：`@wbme/files`（`presignImageUpload` / `finalizeImage` / `presignDownload` / `presignBackupUpload` / 清理列举）。
