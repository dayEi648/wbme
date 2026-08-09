import { Module } from '@nestjs/common';
import { TablePrefsController } from './table-prefs.controller';
import { TablePrefsService } from './table-prefs.service';

/**
 * 个人表格偏好模块（F-9；仅需登录，无功能权限）。
 */
@Module({
  controllers: [TablePrefsController],
  providers: [TablePrefsService],
})
export class TablePrefsModule {}
