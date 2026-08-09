import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ALLOWED_CALLERS_KEY } from './allowed-callers.decorator';
import {
  INTERNAL_CALLER_HEADER,
  INTERNAL_TOKEN_HEADER,
  INTERNAL_TOKEN_MIN_LENGTH,
} from './internal-rest.constants';

/** 内部认证配置注入令牌 */
export const INTERNAL_AUTH_OPTIONS = Symbol('WBME_INTERNAL_AUTH_OPTIONS');

/** 内部令牌校验失败信息（安全日志 INTERNAL_TOKEN_FAILED 事件入参） */
export interface InternalAuthRejection {
  /** 拒绝原因：令牌无效（401）或调用方不在白名单（403） */
  reason: 'TOKEN_INVALID' | 'CALLER_NOT_ALLOWED';
  /** 请求来源 IP（尽力而为） */
  sourceIp?: string;
  /** 声明的调用方服务名（X-WBME-Caller 头，可能缺失） */
  caller?: string;
}

export interface InternalAuthOptions {
  /** 全平台共享内部令牌（部署环境注入，高熵） */
  token: string;
  /**
   * 令牌校验失败回调（写入安全日志 INTERNAL_TOKEN_FAILED）。
   * 失败不阻塞守卫决策，由宿主持有库写入通道（如 platform-core SecurityLogService.record）。
   */
  onReject?: (rejection: InternalAuthRejection) => void;
}

/**
 * 内部路由认证守卫（主 PRD §9.4）。
 *
 * - 恒定时间方式校验 `Authorization: Bearer <token>`；令牌错误返回 401；
 * - 调用方服务名（X-WBME-Caller）必须在路由声明白名单内，否则 403；
 * - 两种失败只记录脱敏安全事件（接入安全日志），不泄露内部信息。
 *
 * 共享令牌只证明请求来自平台可信服务范围，不等于用户权限：
 * 用户触发的跨服务动作必须携带实际操作者标识与业务幂等键，由目标服务另行校验。
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly expectedToken: Buffer;
  private readonly onReject?: (rejection: InternalAuthRejection) => void;

  constructor(
    @Inject(INTERNAL_AUTH_OPTIONS) options: InternalAuthOptions,
    private readonly reflector: Reflector,
  ) {
    if (!options.token || options.token.length < INTERNAL_TOKEN_MIN_LENGTH) {
      throw new Error(`INTERNAL_SERVICE_TOKEN 未配置或长度不足 ${INTERNAL_TOKEN_MIN_LENGTH}（主 PRD §9.4）`);
    }
    this.expectedToken = Buffer.from(options.token);
    this.onReject = options.onReject;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IncomingMessage>();

    if (!this.isTokenValid(request)) {
      // 安全事件回调不阻塞拒绝决策（fire-and-forget；内部事件为只追加审计，丢失不改变授权结果）
      this.onReject?.({
        reason: 'TOKEN_INVALID',
        sourceIp: request.socket?.remoteAddress ?? undefined,
        caller: this.callerOf(request),
      });
      throw new UnauthorizedException();
    }
    if (!this.isCallerAllowed(context, request)) {
      this.onReject?.({
        reason: 'CALLER_NOT_ALLOWED',
        sourceIp: request.socket?.remoteAddress ?? undefined,
        caller: this.callerOf(request),
      });
      throw new ForbiddenException();
    }
    return true;
  }

  /** 提取调用方服务名（X-WBME-Caller 头） */
  private callerOf(request: IncomingMessage): string | undefined {
    const caller = request.headers[INTERNAL_CALLER_HEADER];
    return typeof caller === 'string' ? caller : undefined;
  }

  /** 恒定时间令牌比较：长度不同直接失败（长度非机密），等长用 timingSafeEqual */
  private isTokenValid(request: IncomingMessage): boolean {
    const header = request.headers[INTERNAL_TOKEN_HEADER];
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const provided = Buffer.from(token);
    if (provided.length !== this.expectedToken.length) {
      return false;
    }
    return timingSafeEqual(provided, this.expectedToken);
  }

  /** 调用方服务名必须在路由白名单内 */
  private isCallerAllowed(context: ExecutionContext, request: IncomingMessage): boolean {
    const allowed = this.reflector.get<string[]>(ALLOWED_CALLERS_KEY, context.getHandler()) ?? [];
    const caller = request.headers[INTERNAL_CALLER_HEADER];
    return typeof caller === 'string' && allowed.includes(caller);
  }
}
