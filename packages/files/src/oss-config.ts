import OSS from 'ali-oss';

/** OSS 连接配置（来自环境变量） */
export interface OssEnvConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
}

/**
 * 判断 OSS 凭证是否为占位符（本地开发未配置真实 OSS）。
 *
 * @param env 环境变量（默认 process.env）
 * @returns 占位或未配置时为 true
 */
export function isOssPlaceholder(env: NodeJS.ProcessEnv = process.env): boolean {
  const accessKeyId = env.OSS_ACCESS_KEY_ID?.trim() ?? '';
  const accessKeySecret = env.OSS_ACCESS_KEY_SECRET?.trim() ?? '';
  const bucket = env.OSS_BUCKET?.trim() ?? '';
  const region = env.OSS_REGION?.trim() ?? '';
  if (!accessKeyId || !accessKeySecret || !bucket || !region) {
    return true;
  }
  return accessKeyId === 'change-me' || accessKeySecret === 'change-me';
}

/**
 * 从环境变量读取 OSS 配置。
 *
 * @param env 环境变量
 * @returns 配置对象；占位时返回 null
 */
export function readOssConfig(env: NodeJS.ProcessEnv = process.env): OssEnvConfig | null {
  if (isOssPlaceholder(env)) {
    return null;
  }
  return {
    accessKeyId: env.OSS_ACCESS_KEY_ID!.trim(),
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET!.trim(),
    bucket: env.OSS_BUCKET!.trim(),
    region: env.OSS_REGION!.trim(),
  };
}

/**
 * 创建阿里云 OSS 客户端；凭证为占位符时返回 null（调用方应使用 LocalFileStorage）。
 *
 * @param env 环境变量
 * @returns ali-oss 客户端或 null
 */
export function createOssClient(env: NodeJS.ProcessEnv = process.env): OSS | null {
  const config = readOssConfig(env);
  if (!config) {
    return null;
  }
  return new OSS({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    bucket: config.bucket,
    region: config.region,
  });
}
