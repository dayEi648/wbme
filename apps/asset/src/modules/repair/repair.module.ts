import { Module } from '@nestjs/common';
import { RepairController } from './repair.controller';
import { RepairService } from './repair.service';

/**
 * 固定资产维修管理模块（T7-2；asset PRD §4）。
 */
@Module({
  controllers: [RepairController],
  providers: [RepairService],
  exports: [RepairService],
})
export class RepairModule {}
