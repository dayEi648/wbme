import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationErrors } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import { HolidayAdapter } from './holiday.adapter';
import { FakeHolidayGateway, HolidayGatewayError } from './holiday.gateway';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/** 构造合法的工作日响应（type=0） */
function workdayResponse(date: string, week: number): string {
  return JSON.stringify({ code: 0, type: { type: 0, name: '周一', week }, holiday: null });
}

/** 构造合法的节假日响应（type=2 wage=3） */
function holidayResponse(date: string, week: number): string {
  return JSON.stringify({
    code: 0,
    type: { type: 2, name: '节日（休）', week },
    holiday: { holiday: true, name: '节日（休）', wage: 3, date },
  });
}

/**
 * 节假日适配器集成测试（T6-4）：
 * 外部成功落库、24h 缓存复用、依赖失败降级链（旧结果 → 离线 → HOLIDAY_API_UNAVAILABLE）、并发合并。
 */
describeDb('节假日适配器（T6-4）', () => {
  let prisma: PrismaService;
  let gateway: FakeHolidayGateway;
  let adapter: HolidayAdapter;
  /** 本用例占用的日期（清理用） */
  const usedDates: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    gateway = new FakeHolidayGateway(async () => {
      throw new Error('测试须显式注入网关行为');
    });
    adapter = new HolidayAdapter(prisma, gateway);
  });

  afterAll(async () => {
    await prisma.client.holidayResult.deleteMany({
      where: { holidayDate: { in: usedDates.map((d) => new Date(`${d}T00:00:00Z`)) } },
    });
    await prisma.client.$disconnect();
  });

  it('外部调用成功：按日期 UPSERT 落库并返回 source=ailcc', async () => {
    const date = '2026-03-02'; // 周一
    usedDates.push(date);
    gateway.handler = async (d) => {
      expect(d).toBe(date);
      return workdayResponse(date, 1);
    };
    const result = await adapter.resolve(date);
    expect(result.dateType).toBe('WORKDAY');
    expect(result.source).toBe('ailcc');
    expect(result.digest).toHaveLength(64);
    const row = await prisma.client.holidayResult.findUnique({ where: { holidayDate: new Date(`${date}T00:00:00Z`) } });
    expect(row?.providerId).toBe('ailcc');
  });

  it('24 小时内已保存结果直接复用（source=saved，不调用外部）', async () => {
    const date = '2026-03-03'; // 周二
    usedDates.push(date);
    gateway.handler = async (d) => workdayResponse(d, 2);
    await adapter.resolve(date); // 首次外部调用落库
    let calls = 0;
    gateway.handler = async (d) => {
      calls += 1;
      return workdayResponse(d, 2);
    };
    const result = await adapter.resolve(date);
    expect(result.source).toBe('saved');
    expect(calls).toBe(0);
  });

  it('外部失败 + 已有任意已保存结果 → 复用并降级（source=saved）', async () => {
    const date = '2026-03-04'; // 周三
    usedDates.push(date);
    gateway.handler = async (d) => holidayResponse(d, 3);
    await adapter.resolve(date); // 落库
    gateway.handler = async () => {
      throw new HolidayGatewayError('provider down');
    };
    const result = await adapter.resolve(date);
    expect(result.dateType).toBe('HOLIDAY');
    expect(result.source).toBe('saved');
  });

  it('外部失败 + 无已保存结果 + 离线兜底命中 → source=offline-2026（不落库）', async () => {
    const date = '2026-10-01'; // 国庆（法定，离线数据 HOLIDAY）
    usedDates.push(date);
    gateway.handler = async () => {
      throw new HolidayGatewayError('provider down');
    };
    const result = await adapter.resolve(date);
    expect(result.dateType).toBe('HOLIDAY');
    expect(result.source).toBe('offline-2026');
    const row = await prisma.client.holidayResult.findUnique({ where: { holidayDate: new Date(`${date}T00:00:00Z`) } });
    expect(row).toBeNull(); // 离线命中不落库（H-14）
  });

  it('外部失败 + 离线未覆盖（2027）→ HOLIDAY_API_UNAVAILABLE（不按周几猜测）', async () => {
    const date = '2027-01-01'; // 离线数据仅覆盖 2026
    gateway.handler = async () => {
      throw new HolidayGatewayError('provider down');
    };
    await expect(adapter.resolve(date)).rejects.toMatchObject({
      entry: {
        domain: integrationErrors.HOLIDAY_API_UNAVAILABLE.domain,
        code: integrationErrors.HOLIDAY_API_UNAVAILABLE.code,
      },
    });
  });

  it('响应校验失败（供应商返回错配数据）按依赖失败处理', async () => {
    const date = '2026-03-06';
    gateway.handler = async () =>
      JSON.stringify({ code: 0, type: { type: 1, name: '周日', week: 7 }, holiday: { holiday: true, wage: 2, date: '2026-08-09' } });
    // 2026-03-06 无已保存结果且离线数据该日为工作日 → 走离线兜底
    const result = await adapter.resolve(date);
    expect(result.source).toBe('offline-2026');
    expect(result.dateType).toBe('WORKDAY');
  });

  it('同日期 10 并发合并为一次外部调用', async () => {
    const date = '2026-03-09'; // 周一
    usedDates.push(date);
    let calls = 0;
    gateway.handler = async (d) => {
      calls += 1;
      return workdayResponse(d, 1);
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => adapter.resolve(date)));
    expect(results.every((r) => r.dateType === 'WORKDAY')).toBe(true);
    expect(calls).toBe(1);
  });

  it('外部成功响应为 BusinessException 之外的异常不被吞（抛原异常）', async () => {
    gateway.handler = async () => {
      throw new Error('unexpected');
    };
    await expect(adapter.resolve('2026-03-10')).rejects.toThrow('unexpected');
  });
});
