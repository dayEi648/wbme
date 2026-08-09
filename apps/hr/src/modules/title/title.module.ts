import { Module } from '@nestjs/common';
import { TitleController } from './title.controller';
import { TitleRuleService } from './title-rule.service';

/**
 * 职称模块：职称匹配规则维护；当前职称派生查询经 hr.user_titles 只读视图。
 */
@Module({
  controllers: [TitleController],
  providers: [TitleRuleService],
})
export class TitleModule {}
