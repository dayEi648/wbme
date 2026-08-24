import { Module } from '@nestjs/common';
import { SettingsModule } from '../../base/settings/settings.module';
import { DingtalkModule } from '../../base/dingtalk/dingtalk.module';
import { PermissionModule } from '../permission/permission.module';
import { SystemSettingsController } from './system-settings.controller';

/** 系统设置管理模块（backstage PRD §7） */
@Module({
  imports: [SettingsModule, PermissionModule, DingtalkModule],
  controllers: [SystemSettingsController],
})
export class SystemSettingsModule {}
