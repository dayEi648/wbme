import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { SYSTEM_LOG_VIEW_FUNCTION_CODE, PaginationQueryDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { SystemLogService } from './system-log.service';

class ErrorLogQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() level?: string;
  @IsOptional() @IsString() @MaxLength(100) service?: string;
  @IsOptional() @IsString() @MaxLength(200) source?: string;
  @IsOptional() @IsString() @MaxLength(100) errorCategory?: string;
  @IsOptional() @IsString() @MaxLength(64) fingerprint?: string;
  @IsOptional() @IsIn(['PENDING', 'HANDLED', 'IGNORED']) status?: string;
  @IsOptional() @Type(() => Date) from?: Date;
  @IsOptional() @Type(() => Date) to?: Date;
}

class SecurityLogQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() eventType?: string;
  @IsOptional() @Type(() => Number) @IsInt() actorId?: number;
  @IsOptional() @Type(() => Number) @IsInt() targetUserId?: number;
  @IsOptional() @IsIn(['SUCCESS', 'FAILURE']) result?: string;
  @IsOptional() @Type(() => Date) from?: Date;
  @IsOptional() @Type(() => Date) to?: Date;
}

class DisposeErrorLogDto {
  @IsIn(['HANDLED', 'IGNORED'])
  status!: 'HANDLED' | 'IGNORED';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

/**
 * 系统日志管理（backstage PRD §8；T4-3/T4-4）。
 */
@ApiTags('系统日志')
@Controller('system-logs')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(SYSTEM_LOG_VIEW_FUNCTION_CODE)
export class SystemLogController {
  constructor(private readonly systemLog: SystemLogService) {}

  /** 错误日志列表 */
  @Get('errors')
  listErrors(@Query() query: ErrorLogQueryDto): Promise<unknown> {
    return this.systemLog.listErrors(query);
  }

  /** 错误日志详情（含脱敏 sample） */
  @Get('errors/:id')
  getErrorDetail(@Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.systemLog.getErrorDetail(id);
  }

  /** 处置错误日志（PENDING → HANDLED/IGNORED） */
  @Post('errors/:id/dispose')
  disposeError(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() operatorId: number,
    @Body() dto: DisposeErrorLogDto,
  ): Promise<unknown> {
    return this.systemLog.disposeError(id, operatorId, dto.status, dto.remark);
  }

  /** 错误日志导出（脱敏摘要白名单，受单次行数上限与单用户并发约束） */
  @Post('errors/export')
  exportErrors(
    @CurrentUser() userId: number,
    @Query() query: ErrorLogQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    return this.systemLog.exportErrors(userId, query, res);
  }

  /** 安全日志列表 */
  @Get('security')
  listSecurity(@Query() query: SecurityLogQueryDto): Promise<unknown> {
    return this.systemLog.listSecurity(query);
  }

  /** 安全日志导出（字段白名单，含来源 IP） */
  @Post('security/export')
  exportSecurity(
    @CurrentUser() userId: number,
    @Query() query: SecurityLogQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    return this.systemLog.exportSecurity(userId, query, res);
  }
}
