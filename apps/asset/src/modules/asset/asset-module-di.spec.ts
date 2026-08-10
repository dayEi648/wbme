import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { RedisModule } from '@wbme/server';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import { SharedModule } from '../../shared.module';
import { DepartmentClosureService } from '../../shared/department-closure.service';

/**
 * M12 启动冒烟测试：模拟真实装配（全局 SharedModule + RedisModule → AssetModule），
 * 验证 InternalDepartmentController 的 InternalAuthGuard 依赖
 * （INTERNAL_AUTH_OPTIONS）在 AssetModule 上下文可解析——缺失时 Nest
 * 启动即抛 DI 异常（此前手工装配的单测无法发现该问题）。
 */
describe('AssetModule DI smoke (M12)', () => {
  it('should compile with internal guard dependencies resolved', async () => {
    // InternalAuthGuard 构造要求 token ≥ 32 字符（主 PRD §9.4）；
    // 必须先设置 env 再动态导入（AssetModule 装饰器在 import 时读取 env）
    process.env.INTERNAL_SERVICE_TOKEN = 'asset-module-di-smoke-test-token-0123456789';
    // tsconfig module=nodenext：相对导入须带显式扩展名（.js 映射到 .ts，vite/vitest 同规则）
    const { AssetModule } = await import('./asset.module.js');
    const moduleRef = await Test.createTestingModule({
      imports: [SharedModule, RedisModule.forRoot({} as never), AssetModule],
    })
      .overrideProvider(PrismaService).useValue({})
      .overrideProvider(DepartmentClosureService).useValue({})
      .compile();
    expect(moduleRef).toBeDefined();
  });
});
