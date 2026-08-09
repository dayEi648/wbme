import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';

/** 系统设置读取侧模块（管理界面使用） */
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
