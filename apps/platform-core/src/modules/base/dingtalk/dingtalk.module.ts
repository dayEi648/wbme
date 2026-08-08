import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DINGTALK_GATEWAY } from './dingtalk.gateway';
import { DingtalkGatewayImpl } from './dingtalk.gateway.impl';
import { DingtalkStateService } from './dingtalk.state.service';
import { DingtalkController } from './dingtalk.controller';

/** 钉钉 OAuth 模块（base PRD §2；测试注入 FakeDingtalkGateway 覆盖 DINGTALK_GATEWAY） */
@Module({
  imports: [AuthModule],
  providers: [
    { provide: DINGTALK_GATEWAY, useClass: DingtalkGatewayImpl },
    DingtalkStateService,
  ],
  controllers: [DingtalkController],
  exports: [DINGTALK_GATEWAY, DingtalkStateService],
})
export class DingtalkModule {}
