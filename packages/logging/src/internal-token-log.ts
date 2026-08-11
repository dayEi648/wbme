import type { RawSqlClient } from './raw-sql-client';
import { insertSecurityLog } from './security-log';

/**
 * 内部令牌校验失败信息（@wbme/server InternalAuthRejection 的结构化镜像，
 * 避免 logging → server 反向依赖；字段一致即可结构兼容）。
 */
export interface InternalTokenRejection {
  /** 拒绝原因：令牌无效（401）或调用方不在白名单（403） */
  reason: string;
  /** 请求来源 IP（尽力而为，可能缺失） */
  sourceIp?: string;
  /** 声明的调用方服务名（X-WBME-Caller 头，可能缺失） */
  caller?: string;
}

/**
 * 内部令牌拒绝写入安全日志（INTERNAL_TOKEN_FAILED；主 PRD §9.4、backstage PRD §8）。
 *
 * 供 asset/hr 等与 backstage 同库的服务在 InternalRestModule.forRoot 的 onReject 中调用；
 * 写入失败/超时退回容器标准错误输出，不阻塞 401/403 决策，不记录令牌原文。
 *
 * @param client 满足 RawSqlClient 的库客户端（如各服务全局 PrismaService.client）
 * @param rejection 已脱敏的拒绝上下文
 */
export function recordInternalTokenFailure(client: RawSqlClient, rejection: InternalTokenRejection): void {
  void insertSecurityLog(client, {
    eventType: 'INTERNAL_TOKEN_FAILED',
    result: 'FAILURE',
    reason: rejection.reason,
    sourceIp: rejection.sourceIp ?? null,
    context: rejection.caller ? { caller: rejection.caller } : null,
  }).then((written) => {
    if (!written) {
      console.error(`[security-log] INTERNAL_TOKEN_FAILED 写入失败 reason=${rejection.reason}`);
    }
  });
}
