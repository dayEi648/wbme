import { Module } from '@nestjs/common';
import { ProfitController } from './profit.controller';
import { ProfitService } from './profit.service';

/**
 * 利润分析模块（T8-3）：自动字段实时计算与单元格即时保存。
 */
@Module({
  controllers: [ProfitController],
  providers: [ProfitService],
  exports: [ProfitService],
})
export class ProfitModule {}
