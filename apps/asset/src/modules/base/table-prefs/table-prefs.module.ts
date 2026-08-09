import { Module } from '@nestjs/common';
import { TablePrefsController } from './table-prefs.controller';
import { TablePrefsService } from './table-prefs.service';

/**
 * asset 表格偏好模块：筛选预设 + 列设置（A-30），账号维度读写。
 */
@Module({
  controllers: [TablePrefsController],
  providers: [TablePrefsService],
})
export class TablePrefsModule {}
