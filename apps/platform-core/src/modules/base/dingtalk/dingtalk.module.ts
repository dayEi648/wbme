import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DINGTALK_GATEWAY } from './dingtalk.gateway';
import { DingtalkGatewayImpl } from './dingtalk.gateway.impl';
import { DingtalkConfigService } from './dingtalk-config.service';
import { DingtalkStateService } from './dingtalk.state.service';
import { DingtalkController } from './dingtalk.controller';

/** 钉钉 OAuth 模块（base PRD §2；测试注入 FakeDingtalkGateway 覆盖 DINGTALK_GATEWAY） */
@Module({
  imports: [AuthModule],
  providers: [
    { provide: DINGTALK_GATEWAY, useClass: DingtalkGatewayImpl },
    DingtalkConfigService,
    DingtalkStateService,
  ],
  controllers: [DingtalkController],
  exports: [DINGTALK_GATEWAY, DingtalkStateService, DingtalkConfigService],
})
export class DingtalkModule {}
