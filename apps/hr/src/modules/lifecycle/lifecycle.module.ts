import { Module } from '@nestjs/common';
import { InternalRestModule, type InternalAuthRejection } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { recordInternalTokenFailure } from '@wbme/logging';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';

/**
 * 账号生命周期模块：恢复兼容性应用 + 注销待审批岗位申请幂等取消。
 * onReject 将内部令牌校验失败写入 backstage.security_logs（INTERNAL_TOKEN_FAILED）。
 */
@Module({
  imports: [
    InternalRestModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
        onReject: (rejection: InternalAuthRejection) => recordInternalTokenFailure(prisma.client, rejection),
      }),
    }),
  ],
  controllers: [LifecycleController],
  providers: [LifecycleService],
})
export class LifecycleModule {}
