import { DynamicModule, Module, type FactoryProvider, type ModuleMetadata } from '@nestjs/common';
import { InternalAuthGuard, INTERNAL_AUTH_OPTIONS, type InternalAuthOptions } from './internal-auth.guard';

/**
 * 内部 REST 认证模块：提供 InternalAuthGuard 供内部路由挂载。
 * 各部署单元在需要内部路由的模块中 `InternalRestModule.forRoot({ token })`。
 * `onReject` 供宿主注入安全日志写入通道（INTERNAL_TOKEN_FAILED）。
 */
@Module({})
export class InternalRestModule {
  /** 静态配置（无 DI 依赖的 onReject） */
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

  /**
   * 异步配置：可注入 SecurityLogService 等宿主依赖以写入安全日志。
   *
   * @param options Nest 工厂式异步选项
   * @returns 动态模块
   */
  static forRootAsync(options: {
    imports?: ModuleMetadata['imports'];
    // Nest 工厂签名随 inject 变化；与 ConfigModule.forRootAsync 同口径放宽
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useFactory: (...args: any[]) => InternalAuthOptions | Promise<InternalAuthOptions>;
    inject?: FactoryProvider['inject'];
  }): DynamicModule {
    return {
      module: InternalRestModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: INTERNAL_AUTH_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        InternalAuthGuard,
      ],
      exports: [InternalAuthGuard, INTERNAL_AUTH_OPTIONS],
    };
  }
}
