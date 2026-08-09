import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ANNOUNCEMENT_MANAGE_FUNCTION_CODE,
  RELEASE_LOG_VIEW_FUNCTION_CODE,
} from '@wbme/contracts';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { ListReleaseLogsDto } from './content.dto';
import { ReleaseLogService } from './release-log.service';

/**
 * 更新日志只读接口（backstage PRD §8）。
 * announcement_manage 持有者可读（复制为公告来源）。
 */
@ApiTags('更新日志')
@Controller('release-logs')
@UseGuards(FunctionPermissionGuard)
export class ReleaseLogController {
  constructor(private readonly releaseLogs: ReleaseLogService) {}

  @Get()
  @RequireFunction(RELEASE_LOG_VIEW_FUNCTION_CODE)
  listForViewer(@Query() query: ListReleaseLogsDto): Promise<unknown> {
    return this.releaseLogs.list(query);
  }

  /** 公告管理员复制来源用（同一数据，独立权限码） */
  @Get('for-announcement')
  @RequireFunction(ANNOUNCEMENT_MANAGE_FUNCTION_CODE)
  listForAnnouncement(@Query() query: ListReleaseLogsDto): Promise<unknown> {
    return this.releaseLogs.list(query);
  }
}
