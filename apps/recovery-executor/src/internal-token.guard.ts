import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const TOKEN_HEADER = 'authorization';
const CALLER_HEADER = 'x-wbme-caller';

/**
 * 内部调用令牌守卫（主 PRD §9.4 在恢复执行器的落地）。
 *
 * - `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` 恒定时间校验（401）；
 * - 调用方服务名（X-WBME-Caller）必须在白名单内（403）；
 * - 令牌未配置时拒绝全部调用（执行器不暴露未鉴权通道）。
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly allowedCallers: string[]) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    const expected = process.env.INTERNAL_SERVICE_TOKEN?.trim();
    if (!expected) {
      throw new UnauthorizedException('INTERNAL_SERVICE_TOKEN 未配置');
    }
    const header = request.headers[TOKEN_HEADER];
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const provided = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);
    if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
      throw new UnauthorizedException();
    }
    const caller = request.headers[CALLER_HEADER];
    if (typeof caller !== 'string' || !this.allowedCallers.includes(caller)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
