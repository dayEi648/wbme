import { Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';

/**
 * 账号生命周期模块：恢复兼容性应用 + 注销待审批岗位申请幂等取消。
 */
@Module({
  imports: [
    InternalRestModule.forRoot({
      token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    }),
  ],
  controllers: [LifecycleController],
  providers: [LifecycleService],
})
export class LifecycleModule {}
