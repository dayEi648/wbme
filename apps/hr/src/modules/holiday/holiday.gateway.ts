import {
  HOLIDAY_BASE_URL,
  HOLIDAY_FETCH_TIMEOUT_MS,
  HOLIDAY_INFO_PATH,
  HOLIDAY_MAX_RESPONSE_BYTES,
} from './holiday.constants';

/** 外部请求失败（超时/网络/HTTP 非 200/超体量）——统一按依赖失败处理 */
export class HolidayGatewayError extends Error {}

/**
 * 节假日供应商网关（hr PRD §3 外部请求安全边界）：
 * 只接受 HTTPS 白名单基础地址；调用路径只能由服务端以校验后的 YYYY-MM-DD 生成；
 * 禁止跟随重定向；固定连接、响应与响应体大小上限；第三方原始错误不得外泄。
 */
export interface HolidayGateway {
  /**
   * 拉取指定日期的原始响应文本。
   *
   * @param date 校验后的 YYYY-MM-DD（调用方保证格式）
   * @returns 原始响应文本
   * @throws HolidayGatewayError 超时/网络/非 200/超体量
   */
  fetchRaw(date: string): Promise<string>;
}

/**
 * Ailcc 免费节假日接口实现（https://holiday.ailcc.com/api/holiday/info/{date}）。
 * 免费接口默认不需要凭证；以后即使免费替代源需要凭证，也只能从部署机密注入。
 */
export class AilccHolidayGateway implements HolidayGateway {
  /**
   * @param baseUrl 白名单基础地址（默认 HOLIDAY_BASE_URL；测试注入 Fake 用）
   * @param fetchImpl fetch 实现（测试注入）
   */
  constructor(
    private readonly baseUrl: string = HOLIDAY_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * 拉取原始响应文本。
   *
   * @param date YYYY-MM-DD
   * @returns 原始响应文本（UTF-8）
   * @throws HolidayGatewayError 依赖失败
   */
  async fetchRaw(date: string): Promise<string> {
    const url = `${this.baseUrl}${HOLIDAY_INFO_PATH.replace('{date}', date)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(HOLIDAY_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new HolidayGatewayError('节假日服务请求失败（超时或网络错误）');
    }
    if (response.status !== 200) {
      throw new HolidayGatewayError(`节假日服务返回 HTTP ${response.status}`);
    }
    // 响应体大小上限：content-length 预检 + 读体累计计数
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > HOLIDAY_MAX_RESPONSE_BYTES) {
      throw new HolidayGatewayError('节假日服务响应体超过大小上限');
    }
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > HOLIDAY_MAX_RESPONSE_BYTES) {
        throw new HolidayGatewayError('节假日服务响应体超过大小上限');
      }
      return text;
    } catch (error) {
      if (error instanceof HolidayGatewayError) {
        throw error;
      }
      throw new HolidayGatewayError('节假日服务响应读取失败');
    }
  }
}

/** 测试用 Fake 网关（注入固定响应或抛错；handler 可在用例间重赋值） */
export class FakeHolidayGateway implements HolidayGateway {
  /**
   * @param handler 按日期返回响应文本或抛错
   */
  constructor(public handler: (date: string) => Promise<string>) {}

  /**
   * 拉取指定日期的响应（按注入的 handler）。
   *
   * @param date YYYY-MM-DD
   * @returns 原始响应文本
   */
  async fetchRaw(date: string): Promise<string> {
    return this.handler(date);
  }
}
