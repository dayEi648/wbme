import { DynamicModule, Module } from '@nestjs/common';
import { InternalAuthGuard, INTERNAL_AUTH_OPTIONS, type InternalAuthOptions } from './internal-auth.guard';

/**
 * 内部 REST 认证模块：提供 InternalAuthGuard 供内部路由挂载。
 * 各部署单元在需要内部路由的模块中 `InternalRestModule.forRoot({ token })`。
 * `onReject` 供宿主注入安全日志写入通道（INTERNAL_TOKEN_FAILED，T4-4）。
 */
@Module({})
export class InternalRestModule {
  static forRoot(options: InternalAuthOptions): DynamicModule {
    return {
      module: InternalRestModule,
      providers: [
        { provide: INTERNAL_AUTH_OPTIONS, useValue: options },
        InternalAuthGuard,
      ],
      // 配置 token 一并导出：守卫在宿主模块上下文解析依赖时同样可见
      exports: [InternalAuthGuard, INTERNAL_AUTH_OPTIONS],
    };
  }
}
