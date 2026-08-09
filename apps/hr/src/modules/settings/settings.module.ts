import { Module } from '@nestjs/common';
import { DictController } from './dict.controller';
import { DictService } from './dict.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * 人事配置模块：hr_settings 运行参数 + hr_dicts 人事字典。
 */
@Module({
  controllers: [SettingsController, DictController],
  providers: [SettingsService, DictService],
  exports: [SettingsService],
})
export class SettingsModule {}
