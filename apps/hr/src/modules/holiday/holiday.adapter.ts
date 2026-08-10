import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException, integrationErrors } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import {
  HOLIDAY_CACHE_TTL_MS,
  HOLIDAY_GATEWAY,
  HOLIDAY_MAX_CONCURRENT_FETCHES,
  HOLIDAY_OFFLINE_VERSION,
  HOLIDAY_PROVIDER_ID,
} from './holiday.constants';
import { FakeHolidayGateway, type HolidayGateway, HolidayGatewayError } from './holiday.gateway';
import { Semaphore } from './holiday.semaphore';
import { NormalizedHoliday, validateHolidayResponse } from './holiday.validator';
import offlineHoliday2026 from './offline-holiday-2026.json';

/** 离线兜底数据结构（随版本内置；命中不落库） */
interface OfflineHolidayData {
  year: number;
  source: string;
  days: Record<string, { type: NormalizedHoliday['dateType'] }>;
}

/**
 * 节假日适配器（hr PRD §3）：
 *
 * 调用、缓存与限流：
 *   1) 同进程同日期并发合并为一次外部请求（inflight Promise 复用）；
 *   2) 相同日期 24 小时内已成功获取的规范化结果直接复用（holiday_results 表）；
 *   3) 否则调用免费 API（有界限流），成功后在 PostgreSQL 按日期 UPSERT 规范化结果；
 *   4) 调用失败时：有任意已保存结果（不限 24h）则复用并记录本次依赖失败；
 *      没有已保存结果时回落随版本内置的离线兜底数据；内置未覆盖才返回
 *      DEPENDENCY + HOLIDAY_API_UNAVAILABLE。不按周一至周五自行猜测。
 * 响应严格校验 + SHA-256 摘要 + 快照不追溯（已提交/已审批记录不受后续数据变化影响）。
 */
@Injectable()
export class HolidayAdapter {
  private readonly logger = new Logger(HolidayAdapter.name);
  /** 同日期并发合并表：date → 进行中的 Promise（失败即清理，允许后续请求重试） */
  private readonly inflight = new Map<string, Promise<NormalizedHoliday>>();
  private readonly semaphore = new Semaphore(HOLIDAY_MAX_CONCURRENT_FETCHES);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HOLIDAY_GATEWAY) private readonly gateway: HolidayGateway,
  ) {}

  /**
   * 查询日期类型（规范化为 hr 枚举；写入/复用 holiday_results 缓存）。
   *
   * @param date YYYY-MM-DD（调用方保证格式合法）
   * @returns 规范化节假日结果（dateType/weekday/source/digest/fetchedAt）
   * @throws BusinessException HOLIDAY_API_UNAVAILABLE 缓存与离线均未覆盖时
   */
  async resolve(date: string): Promise<NormalizedHoliday> {
    const existing = this.inflight.get(date);
    if (existing) {
      return existing;
    }
    const task = this.resolveOnce(date);
    this.inflight.set(date, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(date);
    }
  }

  /** 单次解析（同日期并发由 resolve 合并；失败清理后重试） */
  private async resolveOnce(date: string): Promise<NormalizedHoliday> {
    // 1) 24 小时内的已保存成功结果直接复用（source 透传原始供应商标识，L11：
    //    覆盖为 'saved' 会使快照失去供应商标识且与降级复用无法区分）
    const cached = await this.findFreshCached(date);
    if (cached) {
      return cached;
    }
    // 2) 外部调用（有界限流；严格校验；成功 UPSERT）
    try {
      const raw = await this.semaphore.acquire().then(async (release) => {
        try {
          return await this.gateway.fetchRaw(date);
        } finally {
          release();
        }
      });
      const result = validateHolidayResponse(raw, date, HOLIDAY_PROVIDER_ID, new Date().toISOString());
      if (result.ok) {
        await this.upsertCached(date, result.rawDigest, result.normalized);
        return result.normalized;
      }
      this.logger.warn(`节假日响应校验失败（${date}）：${result.reason}`);
    } catch (error) {
      if (error instanceof HolidayGatewayError) {
        this.logger.warn(`节假日 API 调用失败（${date}）：${error.message}`);
      } else {
        throw error;
      }
    }
    // 3) 依赖失败降级：复用任意已保存结果（不限 24h，日志记录本次依赖失败；
    //    source 透传原始供应商标识，L11）
    const anySaved = await this.findAnySaved(date);
    if (anySaved) {
      this.logger.warn(`节假日 API 不可用（${date}），复用已保存结果`);
      return anySaved;
    }
    // 4) 离线兜底（版本控制静态数据；命中不落库，快照记录降级来源标识）
    const offline = this.lookupOffline(date);
    if (offline) {
      return offline;
    }
    // 5) 均未覆盖：依赖失败（不按周一至周五猜测）
    throw new BusinessException(integrationErrors.HOLIDAY_API_UNAVAILABLE, { date });
  }

  /** 查询 24 小时内已保存的成功结果 */
  private async findFreshCached(date: string): Promise<NormalizedHoliday | null> {
    const row = await this.prisma.client.holidayResult.findUnique({ where: { holidayDate: toDbDate(date) } });
    if (!row || row.fetchedAt.getTime() < Date.now() - HOLIDAY_CACHE_TTL_MS) {
      return null;
    }
    return normalizeRow(row);
  }

  /** 查询任意已保存结果（不限 24h；依赖失败降级复用） */
  private async findAnySaved(date: string): Promise<NormalizedHoliday | null> {
    const row = await this.prisma.client.holidayResult.findUnique({ where: { holidayDate: toDbDate(date) } });
    return row ? normalizeRow(row) : null;
  }

  /** UPSERT 规范化结果到 holiday_results（按日期主键） */
  private async upsertCached(date: string, rawDigest: string, normalized: NormalizedHoliday): Promise<void> {
    await this.prisma.client.holidayResult.upsert({
      where: { holidayDate: toDbDate(date) },
      create: {
        holidayDate: toDbDate(date),
        dateType: normalized.dateType,
        weekday: normalized.weekday,
        providerId: HOLIDAY_PROVIDER_ID,
        rawDigest,
        normalized: normalized as object,
        fetchedAt: new Date(normalized.fetchedAt),
      },
      update: {
        dateType: normalized.dateType,
        weekday: normalized.weekday,
        providerId: HOLIDAY_PROVIDER_ID,
        rawDigest,
        normalized: normalized as object,
        fetchedAt: new Date(normalized.fetchedAt),
      },
    });
  }

  /** 离线兜底查询（2026 全年按国办发明电〔2025〕7号；命中记录降级来源标识） */
  private lookupOffline(date: string): NormalizedHoliday | null {
    const data = offlineHoliday2026 as unknown as OfflineHolidayData;
    const entry = data.days[date];
    if (!entry) {
      return null;
    }
    const fetchedAt = new Date().toISOString();
    return {
      dateType: entry.type,
      weekday: weekdayOf(date),
      source: HOLIDAY_OFFLINE_VERSION,
      digest: HOLIDAY_OFFLINE_VERSION,
      fetchedAt,
    };
  }
}

/** holiday_results 行 → 规范化结果（快照字段从 normalized JSON 恢复，保证提交快照完整可复现） */
function normalizeRow(row: {
  dateType: NormalizedHoliday['dateType'];
  weekday: number;
  providerId: string;
  fetchedAt: Date;
  normalized: unknown;
}): NormalizedHoliday {
  const stored = (row.normalized ?? {}) as Partial<NormalizedHoliday>;
  return {
    dateType: row.dateType,
    weekday: row.weekday,
    source: row.providerId,
    digest: typeof stored.digest === 'string' ? stored.digest : '',
    fetchedAt: typeof stored.fetchedAt === 'string' ? stored.fetchedAt : row.fetchedAt.toISOString(),
  };
}

/** YYYY-MM-DD → Date（Date.UTC 构造：日期字符串即日历值，避免北京 00:00 跨 UTC 日界） */
function toDbDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

/** 日期对应星期（周一=1 … 周日=7；Date.UTC 构造不经时区换算） */
function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** 测试辅助：外部网关工厂（Fake 注入入口） */
export { FakeHolidayGateway };
