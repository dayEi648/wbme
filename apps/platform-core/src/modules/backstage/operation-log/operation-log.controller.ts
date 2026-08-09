import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { OPERATION_LOG_VIEW_FUNCTION_CODE, PaginationQueryDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { OperationLogService } from './operation-log.service';

/** 操作日志查询参数 */
class OperationLogQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  system?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  feature?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  operatorId?: number;

  @IsOptional()
  @IsIn(['CREATE', 'UPDATE', 'DELETE', 'EXPORT'])
  actionType?: string;

  @IsOptional()
  @Type(() => Date)
  from?: Date;

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
      actionType: query.actionType,
      from: query.from,
      to: query.to,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  /** 导出操作日志（xlsx 流；T4-11） */
  @Post('export')
  async export(
    @CurrentUser() userId: number,
    @Query() query: OperationLogQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.operationLog.export(userId, {
      system: query.system,
      feature: query.feature,
      operatorId: query.operatorId,
      actionType: query.actionType,
      from: query.from,
      to: query.to,
    }, res);
  }
}
