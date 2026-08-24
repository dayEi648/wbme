import { Module } from '@nestjs/common';
import { RuntimeSettingsController } from './runtime-settings.controller';
import { SettingsService } from './settings.service';

/** 系统设置读取侧模块（管理界面使用） */
@Module({
  controllers: [RuntimeSettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
