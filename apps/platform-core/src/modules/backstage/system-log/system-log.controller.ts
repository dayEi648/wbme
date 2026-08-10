import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { SYSTEM_LOG_VIEW_FUNCTION_CODE, PaginationQueryDto } from '@wbme/contracts';
import { CurrentUser, RateLimit, RateLimitGuard } from '@wbme/server';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { SystemLogService } from './system-log.service';

class ErrorLogQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '日志级别', required: false }) @IsOptional() @IsString() level?: string;
  @ApiProperty({ description: '服务名', required: false, maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) service?: string;
  @ApiProperty({ description: '来源模块', required: false, maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) source?: string;
  @ApiProperty({ description: '错误分类', required: false, maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) errorCategory?: string;
  @ApiProperty({ description: '指纹（聚合键）', required: false, maxLength: 64 }) @IsOptional() @IsString() @MaxLength(64) fingerprint?: string;
  @ApiProperty({ description: '处理状态', required: false, enum: ['PENDING', 'HANDLED', 'IGNORED'] }) @IsOptional() @IsIn(['PENDING', 'HANDLED', 'IGNORED']) status?: string;
  @ApiProperty({ description: '开始时间（含）', required: false, type: 'string', format: 'date-time' }) @IsOptional() @Type(() => Date) from?: Date;
  @ApiProperty({ description: '结束时间（含）', required: false, type: 'string', format: 'date-time' }) @IsOptional() @Type(() => Date) to?: Date;
}

class SecurityLogQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '事件类型', required: false }) @IsOptional() @IsString() eventType?: string;
  @ApiProperty({ description: '操作者用户 id', required: false, minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() actorId?: number;
  @ApiProperty({ description: '目标用户 id', required: false, minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() targetUserId?: number;
  @ApiProperty({ description: '结果', required: false, enum: ['SUCCESS', 'FAILURE'] }) @IsOptional() @IsIn(['SUCCESS', 'FAILURE']) result?: string;
  @ApiProperty({ description: '开始时间（含）', required: false, type: 'string', format: 'date-time' }) @IsOptional() @Type(() => Date) from?: Date;
  @ApiProperty({ description: '结束时间（含）', required: false, type: 'string', format: 'date-time' }) @IsOptional() @Type(() => Date) to?: Date;
}

class DisposeErrorLogDto {
  @ApiProperty({
    description: '处置动作：HANDLED=已处理 / IGNORED=已忽略',
    enum: ['HANDLED', 'IGNORED'],
  })
  @IsIn(['HANDLED', 'IGNORED'])
  status!: 'HANDLED' | 'IGNORED';

  @ApiProperty({
    description: '处置备注',
    required: false,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

/**
 * 系统日志管理（backstage PRD §8）。
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
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'system-log-errors-export', keyType: 'user', limit: 20, windowSeconds: 3600 })
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
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'system-log-security-export', keyType: 'user', limit: 20, windowSeconds: 3600 })
  exportSecurity(
    @CurrentUser() userId: number,
    @Query() query: SecurityLogQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    return this.systemLog.exportSecurity(userId, query, res);
  }
}
