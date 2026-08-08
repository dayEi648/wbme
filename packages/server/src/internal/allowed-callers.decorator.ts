import { SetMetadata } from '@nestjs/common';
import type { InternalService } from './internal-rest.constants';

/** 路由允许的调用方服务白名单元数据键 */
export const ALLOWED_CALLERS_KEY = 'wbme:allowed-callers';

/**
 * 声明内部路由允许的调用方服务白名单（主 PRD §9.4）。
 * 与 InternalAuthGuard 配合：令牌校验通过后，调用方服务名必须在此白名单内，否则 403。
 * @param callers 允许调用本路由的服务
 */
export function AllowedCallers(...callers: InternalService[]): MethodDecorator {
  return SetMetadata(ALLOWED_CALLERS_KEY, callers);
}
