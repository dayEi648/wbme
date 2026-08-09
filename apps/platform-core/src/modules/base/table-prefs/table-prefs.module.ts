import { Module } from '@nestjs/common';
import { TablePrefsController } from './table-prefs.controller';
import { TablePrefsService } from './table-prefs.service';

/** 用户表格偏好 */
@Module({
  controllers: [TablePrefsController],
  providers: [TablePrefsService],
  exports: [TablePrefsService],
})
export class TablePrefsModule {}
