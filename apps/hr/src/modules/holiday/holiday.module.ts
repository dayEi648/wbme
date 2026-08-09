import { Module } from '@nestjs/common';
import { HOLIDAY_GATEWAY } from './holiday.constants';
import { AilccHolidayGateway } from './holiday.gateway';
import { HolidayAdapter } from './holiday.adapter';

/**
 * 节假日模块（T6-4）：免费节假日 API 适配器（hr PRD §3）。
 * 无业务路由（前端不直连第三方，加班表单经后端适配器判断日期类型）。
 * 网关经 token 注入，测试可替换 Fake。
 */
@Module({
  providers: [
    HolidayAdapter,
    { provide: HOLIDAY_GATEWAY, useClass: AilccHolidayGateway },
  ],
  exports: [HolidayAdapter],
})
export class HolidayModule {}
