import { Module } from '@nestjs/common';
import { DictController } from './dict.controller';
import { DictService } from './dict.service';

/**
 * 财务字典模块（T8-7）：项目进度/资料齐全度/业务分类/地区。
 */
@Module({
  controllers: [DictController],
  providers: [DictService],
  exports: [DictService],
})
export class DictModule {}
