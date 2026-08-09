import { Module } from '@nestjs/common';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';
import { DictController } from './dict.controller';
import { DictService } from './dict.service';

/**
 * 资产分类与业务字典模块（T7-11；asset PRD §3/§12）。
 */
@Module({
  controllers: [CategoryController, DictController],
  providers: [CategoryService, DictService],
  exports: [CategoryService],
})
export class CatalogModule {}
