import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  type InternalTokenFailure,
  type InternalTokenFailureRecorder,
  InternalSecurityLogService,
} from './internal-security-log.service';

const TOKEN_HEADER = 'authorization';
const CALLER_HEADER = 'x-wbme-caller';

/**
 * 内部调用令牌守卫（主 PRD §9.4 在恢复执行器的落地）。
 *
 * - `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` 恒定时间校验（401）；
 * - 调用方服务名（X-WBME-Caller）必须在白名单内（403）；
 * - 令牌未配置时拒绝全部调用（执行器不暴露未鉴权通道）；
 * - 校验失败通过共享日志模块写入 backstage.security_logs；数据库不可写时才退回 stderr。
 */
export class InternalTokenGuard implements CanActivate {
  constructor(
    private readonly allowedCallers: readonly string[],
    private readonly securityLog: InternalTokenFailureRecorder,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    const expected = process.env.INTERNAL_SERVICE_TOKEN?.trim();
    if (!expected) {
      this.logReject('TOKEN_UNCONFIGURED', request);
      throw new UnauthorizedException('INTERNAL_SERVICE_TOKEN 未配置');
    }
    const header = request.headers[TOKEN_HEADER];
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const provided = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);
    if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
      this.logReject('TOKEN_INVALID', request);
      throw new UnauthorizedException();
    }
    const caller = request.headers[CALLER_HEADER];
    if (typeof caller !== 'string' || !this.allowedCallers.includes(caller)) {
      this.logReject('CALLER_NOT_ALLOWED', request);
      throw new ForbiddenException();
    }
    return true;
  }

  /**
   * 记录内部令牌校验失败（脱敏：不写令牌本身）。
   *
   * @param reason 拒绝原因
   * @param request 原始请求（取来源 IP、声明调用方和 requestId）
   */
  private logReject(reason: InternalTokenFailure['reason'], request: IncomingMessage): void {
    const caller = request.headers[CALLER_HEADER];
    const sourceIp = request.socket?.remoteAddress ?? null;
    const requestId = request.headers['x-request-id'];
    void this.securityLog.recordInternalTokenFailure({
      reason,
      caller: typeof caller === 'string' ? caller : null,
      sourceIp,
      requestId: typeof requestId === 'string' ? requestId : null,
    });
  }
}

/** Worker 仅可投递恢复任务 */
@Injectable()
export class WorkerInternalTokenGuard extends InternalTokenGuard {
  constructor(securityLog: InternalSecurityLogService) {
    super(['worker'], securityLog);
  }
}

/** platform-core 仅可签发恢复控制会话 */
@Injectable()
export class PlatformCoreInternalTokenGuard extends InternalTokenGuard {
  constructor(securityLog: InternalSecurityLogService) {
    super(['platform-core'], securityLog);
  }
}

/** 磁盘状态仅向需要容量门禁的部署单元开放 */
@Injectable()
export class DiskStatusInternalTokenGuard extends InternalTokenGuard {
  constructor(securityLog: InternalSecurityLogService) {
    super(['platform-core', 'fin', 'worker'], securityLog);
  }
}
