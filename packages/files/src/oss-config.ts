import OSS from 'ali-oss';

/** OSS 连接配置（来自环境变量） */
export interface OssEnvConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
}

/** 显式占位符值 */
const PLACEHOLDER_VALUES = new Set(['change-me', '']);

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
  return PLACEHOLDER_VALUES.has(accessKeyId) || PLACEHOLDER_VALUES.has(accessKeySecret);
}

/**
 * 从环境变量读取 OSS 静态凭证配置。
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

/** ECS 实例元数据服务端点（阿里云固定链路-local IP） */
const ECS_METADATA_BASE = 'http://100.100.100.200/latest/meta-data/ram/security-credentials';

/** 元数据请求超时（毫秒） */
const ECS_METADATA_TIMEOUT_MS = 3_000;

/** ECS RAM 角色 STS 凭证响应 */
interface EcsRamCredentials {
  AccessKeyId: string;
  AccessKeySecret: string;
  SecurityToken: string;
  Expiration: string;
  Code: string;
}

/** 带超时的 fetch */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 从 ECS 实例元数据获取 RAM 角色名（单角色时直接返回；多角色取第一行） */
async function fetchEcsRamRoleName(): Promise<string> {
  const res = await fetchWithTimeout(ECS_METADATA_BASE, ECS_METADATA_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`获取 ECS RAM 角色名失败：HTTP ${res.status}`);
  }
  const text = (await res.text()).trim();
  if (!text) {
    throw new Error('当前 ECS 实例未关联 RAM 角色');
  }
  const [first] = text.split('\n');
  if (!first) {
    throw new Error('当前 ECS 实例未关联 RAM 角色');
  }
  return first.trim();
}

/** 从 ECS 实例元数据获取指定角色的 STS 临时凭证 */
async function fetchEcsRamCredentials(roleName: string): Promise<EcsRamCredentials> {
  const res = await fetchWithTimeout(
    `${ECS_METADATA_BASE}/${encodeURIComponent(roleName)}`,
    ECS_METADATA_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`获取 ECS RAM 临时凭证失败：HTTP ${res.status}`);
  }
  const data = (await res.json()) as EcsRamCredentials;
  if (data.Code !== 'Success') {
    throw new Error(`ECS RAM 凭证返回 Code=${data.Code}`);
  }
  if (!data.AccessKeyId || !data.AccessKeySecret || !data.SecurityToken) {
    throw new Error('ECS RAM 凭证字段不完整');
  }
  return data;
}

/** 将 ECS 凭证转换为 ali-oss 刷新回调格式 */
function normalizeForAliOss(creds: EcsRamCredentials) {
  return {
    accessKeyId: creds.AccessKeyId,
    accessKeySecret: creds.AccessKeySecret,
    stsToken: creds.SecurityToken,
  };
}

/** 使用 ECS RAM 角色创建支持自动刷新 STS 的 OSS 客户端 */
async function createRamRoleOssClient(config: {
  bucket: string;
  region: string;
  roleName?: string;
}): Promise<OSS> {
  const roleName = config.roleName ?? (await fetchEcsRamRoleName());
  const initial = await fetchEcsRamCredentials(roleName);
  return new OSS({
    bucket: config.bucket,
    region: config.region,
    accessKeyId: initial.AccessKeyId,
    accessKeySecret: initial.AccessKeySecret,
    stsToken: initial.SecurityToken,
    refreshSTSToken: async () => fetchEcsRamCredentials(roleName).then(normalizeForAliOss),
    refreshSTSTokenInterval: 5 * 60 * 1000,
  });
}

/**
 * 判断 OSS 基础配置（bucket/region）是否已填写。
 */
function hasOssBaseConfig(env: NodeJS.ProcessEnv): { bucket: string; region: string } | null {
  const bucket = env.OSS_BUCKET?.trim() ?? '';
  const region = env.OSS_REGION?.trim() ?? '';
  if (!bucket || !region || PLACEHOLDER_VALUES.has(bucket) || PLACEHOLDER_VALUES.has(region)) {
    return null;
  }
  return { bucket, region };
}

/**
 * 创建阿里云 OSS 客户端。
 *
 * 优先级：
 * 1. 静态 AK/SK（开发环境）；
 * 2. ECS 实例 RAM 角色（生产环境，无 AK/SK 时自动尝试）；
 * 3. 开发环境回退到 null（调用方使用 LocalFileStorage）；
 * 4. 生产环境无法获取凭证时直接抛配置错误（禁止静默回退本地替身）。
 *
 * @param env 环境变量
 * @returns ali-oss 客户端或 null（仅开发环境）
 */
export async function createOssClient(env: NodeJS.ProcessEnv = process.env): Promise<OSS | null> {
  const explicitConfig = readOssConfig(env);
  if (explicitConfig) {
    return new OSS({
      accessKeyId: explicitConfig.accessKeyId,
      accessKeySecret: explicitConfig.accessKeySecret,
      bucket: explicitConfig.bucket,
      region: explicitConfig.region,
    });
  }

  const baseConfig = hasOssBaseConfig(env);
  if (baseConfig) {
    const roleName = env.OSS_RAM_ROLE_NAME?.trim() || undefined;
    try {
      return await createRamRoleOssClient({ ...baseConfig, roleName });
    } catch (error) {
      if (env.NODE_ENV === 'production') {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`生产环境 OSS 凭证缺失且无法通过 ECS RAM 角色获取：${reason}`);
      }
      return null;
    }
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      '生产环境 OSS 未配置：请填写 OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET，或配置 ECS RAM 角色（OSS_BUCKET/OSS_REGION/OSS_RAM_ROLE_NAME）',
    );
  }
  return null;
}
