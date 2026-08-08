import { DynamicModule, Global, Module } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';
import { CsrfService } from './csrf.service';
import { SessionService } from './session.service';

/**
 * 会话与 CSRF 基础设施模块（共享包，各部署单元装配；@Global 供业务模块直接注入）。
 *
 * 会话守卫依赖的注入令牌（SESSION_USER_LOADER / SESSION_IDLE_TIMEOUT_PROVIDER）
 * 由宿主部署单元在其根模块 providers 中提供：
 * 加载器读自身数据库，空闲超时按"记住我"读自身系统设置。
 * CSRF 签名密钥缺省读环境变量 COOKIE_SIGNING_KEY（部署级机密，缺失拒绝启动）。
 */
@Global()
@Module({})
export class SessionModule {
  static forRoot(options: { csrfSigningKey?: string } = {}): DynamicModule {
    const signingKey = options.csrfSigningKey ?? process.env.COOKIE_SIGNING_KEY ?? '';
    return {
      module: SessionModule,
      providers: [
        SessionService,
        CsrfGuard,
        { provide: CsrfService, useValue: new CsrfService(signingKey) },
      ],
      exports: [SessionService, CsrfGuard, CsrfService],
    };
  }
}
