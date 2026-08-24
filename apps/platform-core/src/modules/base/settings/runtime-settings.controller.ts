import { Controller, Get } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Public } from '@wbme/server';
import { SETTING_KEYS, SettingsService } from './settings.service';

/** 公开的最小化前端运行参数；不得在此接口暴露其它平台设置。 */
class NotificationRuntimeSettingsResponse {
  @ApiProperty({ description: '悬浮通知自动关闭时长（秒）', minimum: 1, maximum: 60, example: 5 })
  notificationDurationSeconds!: number;
}

/**
 * 前端运行设置。
 *
 * 登录、激活等公开页面同样会产生即时反馈，因此只读通知时长通过公开端点提供；
 * 返回值严格限定为非敏感的界面展示参数，不复用管理员的完整系统设置接口。
 */
@ApiTags('前端运行设置')
@Controller('runtime-settings')
export class RuntimeSettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** 获取全站悬浮通知的自动关闭时长。 */
  @Public()
  @Get('notifications')
  async notifications(): Promise<NotificationRuntimeSettingsResponse> {
    return {
      notificationDurationSeconds: await this.settings.getNumber(SETTING_KEYS.NOTIFICATION_DURATION_SECONDS),
    };
  }
}
