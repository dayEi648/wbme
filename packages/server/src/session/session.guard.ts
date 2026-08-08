import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException, accountErrors, frameworkErrors } from '@wbme/contracts';
import type { Request } from 'express';
import { getRequestContext, setRequestUserId } from '../request-context';
import { ACTIVE_INTERACTION_HEADER, SESSION_COOKIE } from './session-constants';
import { SessionService } from './session.service';
import type { SessionUser, SessionUserLoader } from './session-user.loader';

/** 公开路由标记（@Public() 装饰器写入的元数据键） */
export const PUBLIC_ROUTE_KEY = 'wbme_public_route';

/** 会话用户加载器注入令牌 */
export const SESSION_USER_LOADER = Symbol('WBME_SESSION_USER_LOADER');

/**
 * 空闲超时提供者注入令牌：由部署单元按系统设置注入
 * （"记住我"会话使用延长时限，普通会话使用默认时限，base PRD §3）。
 */
export type IdleTimeoutProvider = (rememberMe: boolean) => Promise<number>;
export const SESSION_IDLE_TIMEOUT_PROVIDER = Symbol('WBME_SESSION_IDLE_TIMEOUT_PROVIDER');

/** 标记路由为公开：跳过会话守卫（登录、钉钉回调、激活兑换、健康探针等，主 PRD §9.6） */
export function Public(): MethodDecorator & ClassDecorator {
  const decorator = (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor): void => {
    if (descriptor) {
      Reflect.defineMetadata(PUBLIC_ROUTE_KEY, true, descriptor.value);
      return;
    }
    Reflect.defineMetadata(PUBLIC_ROUTE_KEY, true, target);
  };
  return decorator as MethodDecorator & ClassDecorator;
}

/**
 * 会话守卫（主 PRD §9.6：默认所有面向用户的路由需要登录）。
 *
 * 流程：解析会话 Cookie → Redis 校验（不存在/过期 → 401 SESSION_EXPIRED）→
 * 注入的 loader 加载账号（不存在/软删/非 ACTIVE → 拒绝并删会话）→
 * 会话版本与账号版本一致才放行 → 写请求上下文 userId → 有效交互标记则滑动续期。
 * Redis 故障时本守卫路径自然返回 DEPENDENCY_UNAVAILABLE（主 PRD §9.8）。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly session: SessionService,
    private readonly reflector: Reflector,
    @Inject(SESSION_USER_LOADER) private readonly loader: SessionUserLoader,
    @Inject(SESSION_IDLE_TIMEOUT_PROVIDER) private readonly idleTimeoutProvider: IdleTimeoutProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 显式公开的路由跳过会话校验
    if (this.isPublic(context)) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const sessionId = request.cookies?.[SESSION_COOKIE] ?? this.readCookieHeader(request, SESSION_COOKIE);
    if (!sessionId) {
      // 无会话 Cookie 与"会话已失效"统一为 SESSION_EXPIRED（前端统一跳转登录，base PRD §3）
      throw new BusinessException(frameworkErrors.SESSION_EXPIRED);
    }

    const data = await this.session.read(sessionId);
    if (!data) {
      throw new BusinessException(frameworkErrors.SESSION_EXPIRED);
    }

    const user = await this.loader.load(data.u);
    if (!user) {
      await this.session.destroy(sessionId);
      throw new BusinessException(frameworkErrors.SESSION_EXPIRED);
    }
    if (user.sessionVersion !== data.sv) {
      // 改密/重置/换绑/注销后旧会话立即失效（base PRD §3）
      await this.session.destroy(sessionId);
      throw new BusinessException(frameworkErrors.SESSION_EXPIRED);
    }
    if (user.status !== 'ACTIVE') {
      await this.session.destroy(sessionId);
      if (user.status === 'DEACTIVATED') {
        throw new BusinessException(accountErrors.ACCOUNT_DEACTIVATED);
      }
      throw new BusinessException(accountErrors.ACCOUNT_PENDING_ACTIVATION);
    }

    setRequestUserId(user.id);

    // 仅"有效交互"续期：前端写请求默认带标记，读请求仅页面导航/查询带；轮询/预取/静默刷新不带
    const active = request.headers[ACTIVE_INTERACTION_HEADER];
    if (active === '1' || active === 'true') {
      const idleTimeoutMs = await this.idleTimeoutProvider(data.rm);
      const result = await this.session.touch(sessionId, data, idleTimeoutMs);
      if (!result.valid) {
        throw new BusinessException(frameworkErrors.SESSION_EXPIRED);
      }
    }
    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.get<boolean>(PUBLIC_ROUTE_KEY, context.getHandler()) === true ||
      this.reflector.get<boolean>(PUBLIC_ROUTE_KEY, context.getClass()) === true
    );
  }

  /** cookie-parser 未挂载时的兜底解析 */
  private readCookieHeader(request: Request, name: string): string | undefined {
    const header = request.headers.cookie;
    if (!header) {
      return undefined;
    }
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === name) {
        return decodeURIComponent(part.slice(index + 1).trim());
      }
    }
    return undefined;
  }
}

/**
 * 当前用户参数装饰器：`@CurrentUser() userId: number`。
 * 从请求上下文读取认证守卫写入的 userId。
 */
export const CurrentUser = createParamDecorator((_data: unknown): number => {
  const userId = getRequestContext()?.userId;
  if (userId === undefined) {
    throw new BusinessException(frameworkErrors.UNAUTHORIZED);
  }
  return userId;
});

export type { SessionUser };
