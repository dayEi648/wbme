import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { OPERATION_LOG_VIEW_FUNCTION_CODE, PaginationQueryDto } from '@wbme/contracts';
import { CurrentUser, EXPORT_TIMEOUT_MS, RateLimit, RateLimitGuard, RequestTimeout } from '@wbme/server';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { OperationLogService } from './operation-log.service';

/** 操作日志查询参数 */
class OperationLogQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '系统（base/backstage/asset/hr/fin）', required: false, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  system?: string;

  @ApiProperty({ description: '功能模块', required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  feature?: string;

  @ApiProperty({ description: '操作者用户 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  operatorId?: number;

  @ApiProperty({ description: '部门 id（含下级部门，按操作者操作时部门快照过滤）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @ApiProperty({ description: '动作类型', required: false, enum: ['CREATE', 'UPDATE', 'DELETE', 'EXPORT'] })
  @IsOptional()
  @IsIn(['CREATE', 'UPDATE', 'DELETE', 'EXPORT'])
  actionType?: string;

  @ApiProperty({ description: '开始时间（含）', required: false, type: 'string', format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  from?: Date;

  @ApiProperty({ description: '结束时间（含）', required: false, type: 'string', format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  to?: Date;
}

/**
 * 操作日志查询（backstage PRD §1 权限板块；主 PRD §3.3）。
 */
@ApiTags('操作日志')
@Controller('operation-logs')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(OPERATION_LOG_VIEW_FUNCTION_CODE)
export class OperationLogController {
  constructor(private readonly operationLog: OperationLogService) {}

  /** 分页查询全员操作日志 */
  @Get()
  list(@Query() query: OperationLogQueryDto): Promise<unknown> {
    return this.operationLog.list({
      system: query.system,
      feature: query.feature,
      operatorId: query.operatorId,
      departmentId: query.departmentId,
      actionType: query.actionType,
      from: query.from,
      to: query.to,
      filters: query.filters,
      sorts: query.sorts,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  /**
   * 部门筛选树选项（主 PRD §3.3 筛选清单「部门」）。
   *
   * 经 hr 只读视图读取，hr 容器停止不影响既有日志查询页加载选项；
   * DEPARTMENT 档仅返回其部门闭包及祖先链（保证树可组装）。
   */
  @Get('department-options')
  departmentOptions(): Promise<unknown> {
    return this.operationLog.departmentOptions();
  }

  /** 导出操作日志（xlsx 流） */
  @Post('export')
  @RequestTimeout(EXPORT_TIMEOUT_MS)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'operation-log-export', keyType: 'user', limit: 20, windowSeconds: 3600 })
  async export(
    @CurrentUser() userId: number,
    @Query() query: OperationLogQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.operationLog.export(userId, {
      system: query.system,
      feature: query.feature,
      operatorId: query.operatorId,
      departmentId: query.departmentId,
      actionType: query.actionType,
      from: query.from,
      to: query.to,
      filters: query.filters,
      sorts: query.sorts,
    }, res);
  }
}
