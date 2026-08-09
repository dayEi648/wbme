/**
 * 节假日适配器常量（hr PRD §3）。
 *
 * 供应商域名与 HTTPS 基础地址是受版本控制的部署级集成配置（白名单），
 * 不进入管理页面，也不能由请求参数、数据库普通设置或管理员填写任意 URL；
 * 换源只需修改本文件常量并随正常版本发布。免费接口无需凭证。
 */

/** 供应商基础地址（白名单；仅服务端拼接校验后的 YYYY-MM-DD 日期） */
export const HOLIDAY_BASE_URL = 'https://holiday.ailcc.com';

/** 日期查询路径模板：{date} 仅由服务端以校验后的 YYYY-MM-DD 替换 */
export const HOLIDAY_INFO_PATH = '/api/holiday/info/{date}';

/** 供应商稳定标识（写入 holiday_results.provider_id 与提交快照 source） */
export const HOLIDAY_PROVIDER_ID = 'ailcc';

/** 集成缓存 TTL：24 小时（固定工程参数，不放入人事设置；hr PRD §3） */
export const HOLIDAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 外部请求连接+响应总超时（毫秒） */
export const HOLIDAY_FETCH_TIMEOUT_MS = 5_000;

/** 外部响应体大小上限（字节）：拒绝超体量响应防资源消耗 */
export const HOLIDAY_MAX_RESPONSE_BYTES = 64 * 1024;

/** 进程级并发外部请求上限（供应商公开限额内的有界限流） */
export const HOLIDAY_MAX_CONCURRENT_FETCHES = 4;

/** 网关注入 token（接口不能作值使用，用常量 token 注入） */
export const HOLIDAY_GATEWAY = 'HOLIDAY_GATEWAY';

/** 离线兜底数据版本标识（写入快照 digest：命中离线数据时 source=offline-2026、digest 为版本常量） */
export const HOLIDAY_OFFLINE_VERSION = 'offline-2026';
