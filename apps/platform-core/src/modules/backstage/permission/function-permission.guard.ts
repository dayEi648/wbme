import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { getRequestContext, setGrantedFunction } from '@wbme/server';
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
 * 函数权限守卫（主 PRD §9.6 授权守卫链、§3.1；实现规划 T3-4）。
 *
 * 配合 `@UseGuards(FunctionPermissionGuard)` + `@RequireFunction(code)` 使用，
 * 在全局 SessionGuard 之后执行，依次校验：
 * 1. 登录态：当前用户标识从请求上下文读取（会话守卫已写入，含提权旋转）；
 * 2. 目录注册：路由声明的功能编码必须仍注册于目录（未注册 = 代码/部署缺陷，500）；
 * 3. 系统可用性：所属系统 product_status 必须为 OPEN（未开放系统所有人不可进入，503）；
 * 4. 功能权限：超管豁免，否则须持有有效授权（目录外功能授权不生效，403）；
 * 5. 数据范围上下文：有效数据范围（多档位按最宽合并；超管为 null 不受限）写入请求上下文，
 *    业务层据此做行级过滤，范围外记录视为不存在（404 呈现，主 PRD §3.1）。
 *
 * 授权每次请求实时读取数据库（无授权缓存）：撤权、功能移除、范围定义变更即时生效
 *（base PRD §3 的版本校验缓存机制在引入授权缓存时再行接入，当前无缓存即无失效窗口）。
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
    const access = await this.authorization.getFunctionAccess(userId, required);
    if (!access.registered) {
      // 路由声明了目录中不存在的功能编码：代码缺陷或部署版本错配，不属于越权
      throw new BusinessException(frameworkErrors.INTERNAL_ERROR);
    }
    if (!access.systemOpen) {
      throw new BusinessException(frameworkErrors.SYSTEM_NOT_OPEN, { system: access.systemName });
    }
    if (!access.allowed) {
      throw new BusinessException(frameworkErrors.FORBIDDEN);
    }
    setGrantedFunction({ code: required, dataScope: access.dataScope });
    return true;
  }
}
