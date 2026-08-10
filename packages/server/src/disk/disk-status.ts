import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BusinessException, frameworkErrors } from '@wbme/contracts';

const execFileAsync = promisify(execFile);

/** 磁盘预警阈值（主 PRD §9.13：部署安全常量，可用环境变量覆盖） */
const DEFAULT_DISK_WARN_RATIO = 0.8;
const DEFAULT_DISK_CRITICAL_RATIO = 0.9;
const DISK_STATUS_REQUEST_TIMEOUT_MS = 2_000;

/** 磁盘状态等级 */
export type DiskStatusLevel = 'OK' | 'WARN' | 'CRITICAL';

/** 磁盘使用率汇总（不暴露主机路径） */
export interface DiskStatusSummary {
  status: DiskStatusLevel;
  /** 所测路径中的最高使用率；无法完整测量时为 null */
  usageRatio: number | null;
  /** 所有受监控持久化路径是否均已成功测量（不暴露路径） */
  measurementAvailable: boolean;
}

/**
 * 读取部署安全常量中的预警/严重阈值。
 *
 * @returns warn/critical 比例（0~1）
 */
export function diskThresholds(): { warn: number; critical: number } {
  return {
    warn: parseRatioEnv('HEALTH_DISK_WARN_RATIO', DEFAULT_DISK_WARN_RATIO),
    critical: parseRatioEnv('HEALTH_DISK_CRITICAL_RATIO', DEFAULT_DISK_CRITICAL_RATIO),
  };
}

/**
 * 解析待测量的磁盘路径列表。
 *
 * 优先 `HEALTH_DISK_PATHS`（逗号分隔）；否则默认 `/`，并在配置了
 * `RESTORE_STATE_DIR` 时追加该 ECS 持久化目录。
 *
 * @returns 去重后的绝对路径列表
 */
export function diskPathsToMeasure(): string[] {
  const fromEnv = process.env.HEALTH_DISK_PATHS?.split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (fromEnv && fromEnv.length > 0) {
    return [...new Set(fromEnv)];
  }
  const paths = new Set<string>(['/']);
  const restoreDir = process.env.RESTORE_STATE_DIR?.trim();
  if (restoreDir) {
    paths.add(restoreDir);
  }
  return [...paths];
}

/**
 * 读取本容器可见持久化路径的使用率并以最高值分类（主 PRD §9.13）。
 *
 * 真实执行 `df -k <path>`。任一配置路径无法测量时显式标记为不可用，避免把
 * 未覆盖的数据卷伪装为正常磁盘状态；容量型写入门禁会据此拒绝请求。
 *
 * @param measure 单路径测量函数（测试可注入）
 * @returns 状态与最高使用率
 */
export async function readLocalDiskStatus(
  measure: (path: string) => Promise<number | null> = measurePathUsageRatio,
): Promise<DiskStatusSummary> {
  const paths = diskPathsToMeasure();
  const ratios = await Promise.all(paths.map((path) => measure(path)));
  if (ratios.some((ratio) => ratio === null)) {
    return unavailableDiskStatus();
  }
  const usageRatio = Math.max(...(ratios as number[]));
  return { status: classifyDisk(usageRatio), usageRatio, measurementAvailable: true };
}

/**
 * 读取部署统一磁盘状态。
 *
 * 配置 `HEALTH_DISK_STATUS_URL` 时，调用只读的恢复执行器内部探针，确保 platform-core、
 * fin 与 Worker 使用 PostgreSQL、Redis 和恢复状态目录的同一真实测量结果；未配置时用于
 * 本地开发的本容器测量。
 *
 * @returns 状态与最高使用率
 */
export async function readDiskStatus(): Promise<DiskStatusSummary> {
  const url = process.env.HEALTH_DISK_STATUS_URL?.trim();
  if (!url) {
    return readLocalDiskStatus();
  }
  const token = process.env.INTERNAL_SERVICE_TOKEN?.trim();
  const caller = process.env.DISK_STATUS_CALLER?.trim();
  if (!token || !caller) {
    return unavailableDiskStatus();
  }
  try {
    const response = await fetch(new URL('/recovery/disk', url), {
      headers: {
        authorization: `Bearer ${token}`,
        'x-wbme-caller': caller,
      },
      signal: AbortSignal.timeout(DISK_STATUS_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return unavailableDiskStatus();
    }
    return parseDiskStatus(await response.json());
  } catch {
    return unavailableDiskStatus();
  }
}

/**
 * 磁盘达严重阈值时拒绝写容量型操作（上传 / 导入 / 备份）。
 *
 * @param readStatus 状态读取函数（测试可注入）
 * @throws DEPENDENCY_UNAVAILABLE 无法完整测量目标持久化卷
 * @throws DISK_SPACE_CRITICAL 使用率 ≥ 严重阈值
 */
export async function assertDiskAcceptsCapacityWrites(
  readStatus: () => Promise<DiskStatusSummary> = readDiskStatus,
): Promise<void> {
  const disk = await readStatus();
  if (!disk.measurementAvailable) {
    throw new BusinessException(frameworkErrors.DEPENDENCY_UNAVAILABLE, { target: '磁盘空间检测' });
  }
  if (disk.status === 'CRITICAL') {
    throw new BusinessException(frameworkErrors.DISK_SPACE_CRITICAL);
  }
}

/**
 * 按使用率分类磁盘状态。
 *
 * @param ratio 使用率 0~1
 * @returns OK / WARN / CRITICAL
 */
export function classifyDisk(ratio: number): DiskStatusLevel {
  const { warn, critical } = diskThresholds();
  if (ratio >= critical) {
    return 'CRITICAL';
  }
  if (ratio >= warn) {
    return 'WARN';
  }
  return 'OK';
}

/**
 * 对单个路径执行 `df -k` 并计算使用率。
 *
 * @param path 文件系统路径
 * @returns 使用率；测量失败返回 null
 */
async function measurePathUsageRatio(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('df', ['-k', path]);
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) {
      return null;
    }
    const parts = lines[1]?.split(/\s+/) ?? [];
    // df -k 输出：Filesystem 1K-blocks Used Available Capacity Mounted
    if (parts.length < 3) {
      return null;
    }
    const total = Number(parts[1]);
    const used = Number(parts[2]);
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) {
      return null;
    }
    return used / total;
  } catch {
    return null;
  }
}

/** 无法完整测量时的安全状态（健康页显示严重，容量型写入拒绝） */
function unavailableDiskStatus(): DiskStatusSummary {
  return { status: 'CRITICAL', usageRatio: null, measurementAvailable: false };
}

/** 校验内部探针响应，避免异常负载被当作安全状态 */
function parseDiskStatus(value: unknown): DiskStatusSummary {
  if (!value || typeof value !== 'object') {
    return unavailableDiskStatus();
  }
  const candidate = value as Partial<DiskStatusSummary>;
  if (
    (candidate.status !== 'OK' && candidate.status !== 'WARN' && candidate.status !== 'CRITICAL') ||
    candidate.measurementAvailable !== true ||
    typeof candidate.usageRatio !== 'number' ||
    !Number.isFinite(candidate.usageRatio) ||
    candidate.usageRatio < 0 ||
    candidate.usageRatio > 1
  ) {
    return unavailableDiskStatus();
  }
  return {
    status: candidate.status,
    usageRatio: candidate.usageRatio,
    measurementAvailable: true,
  };
}

/** 解析 0~1 比例环境变量；非法或缺失回退默认值 */
function parseRatioEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    return fallback;
  }
  return value;
}
