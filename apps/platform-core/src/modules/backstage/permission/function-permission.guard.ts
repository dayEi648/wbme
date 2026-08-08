import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { getRequestContext } from '@wbme/server';
import { AuthorizationService } from './authorization.service';

/** 路由所需功能授权的元数据键（@RequireFunction() 写入） */
export const REQUIRED_FUNCTION_KEY = 'wbme_required_function';

/**
 * 声明路由所需的功能授权：持有该功能（或超级管理员）才可访问。
 * 处理器级优先于类级；未声明时守卫不拦截（仅要求登录态，由全局会话守卫保证）。
 */
export function RequireFunction(functionCode: string): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRED_FUNCTION_KEY, functionCode) as MethodDecorator & ClassDecorator;
}

/**
 * 函数权限守卫（主 PRD §3.1；T3-2 供 backstage 权限管理接口使用，T3-4 推广为全站守卫）。
 *
 * 配合 `@UseGuards(FunctionPermissionGuard)` + `@RequireFunction(code)` 使用；
 * 在全局 SessionGuard 之后执行：当前用户标识从请求上下文读取（会话守卫已写入），
 * 授权判断委托 AuthorizationService（超管豁免 + 目录存在性过滤）。
 */
@Injectable()
export class FunctionPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.get<string>(REQUIRED_FUNCTION_KEY, context.getHandler()) ??
      this.reflector.get<string>(REQUIRED_FUNCTION_KEY, context.getClass());
    if (!required) {
      return true;
    }
    const userId = getRequestContext()?.userId;
    if (userId === undefined) {
      throw new BusinessException(frameworkErrors.UNAUTHORIZED);
    }
    if (await this.authorization.hasFunction(userId, required)) {
      return true;
    }
    throw new BusinessException(frameworkErrors.FORBIDDEN);
  }
}
