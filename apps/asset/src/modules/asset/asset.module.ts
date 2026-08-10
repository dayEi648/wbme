import { Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';
import { InternalDepartmentController } from './internal-department.controller';

/**
 * 固定资产台账模块（asset PRD §4）。
 *
 * 内部路由（InternalDepartmentController 挂 InternalAuthGuard）需要
 * INTERNAL_AUTH_OPTIONS 在模块上下文可见：与 ApprovalModule 相同方式
 * forRoot 提供（M12；兄弟模块的 provider 不横向传播，缺失会导致 DI 启动失败）。
 */
@Module({
  imports: [InternalRestModule.forRoot({ token: process.env.INTERNAL_SERVICE_TOKEN ?? '' })],
  controllers: [AssetController, InternalDepartmentController],
  providers: [AssetService],
  exports: [AssetService],
})
export class AssetModule {}
