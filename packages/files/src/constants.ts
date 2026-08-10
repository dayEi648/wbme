/** 前缀规范化：环境变量值可能不带尾部斜杠（.env.production.example 示例值），统一补 `/` */
function normalizePrefix(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

/** OSS 对象键前缀：用户图片（与备份隔离）；环境变量 OSS_PREFIX_IMAGES 可覆盖（默认 images/） */
export const OSS_PREFIX_IMAGES = normalizePrefix(process.env.OSS_PREFIX_IMAGES ?? 'images');

/** OSS 对象键前缀：数据库备份（与图片隔离）；环境变量 OSS_PREFIX_BACKUPS 可覆盖（默认 backups/） */
export const OSS_PREFIX_BACKUPS = normalizePrefix(process.env.OSS_PREFIX_BACKUPS ?? 'backups');

/** 图片上传预签名有效期（秒） */
export const IMAGE_PRESIGN_EXPIRES_SECONDS = 300;

/** 图片最大体积（字节）：1MB */
export const IMAGE_MAX_BYTES = 1_048_576;

/** 备份预签名/直传有效期（秒） */
export const BACKUP_PRESIGN_EXPIRES_SECONDS = 3_600;

/** 本地开发 OSS 替身目录（相对仓库根） */
export const LOCAL_OSS_ROOT = '.agents/tmp-oss';
