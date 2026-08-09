import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { HEALTH_STATUS_FUNCTION_CODE } from '@wbme/contracts';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { HealthStatusService } from './health-status.service';

/** 健康状态管理页 API */
@ApiTags('健康状态')
@Controller('health-status')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(HEALTH_STATUS_FUNCTION_CODE)
export class HealthStatusController {
  constructor(private readonly health: HealthStatusService) {}

  @Get()
  overview(): Promise<unknown> {
    return this.health.getOverview();
  }
}
