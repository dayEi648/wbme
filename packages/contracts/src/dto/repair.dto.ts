import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { isNonNegativeAmount } from '../money';
import { isRfc3339Utc } from '../time';
import { IdempotentDto, IsValidatedBy, PaginationQueryDto } from './base.dto';
import type { AssetStatus } from './fixed-asset.dto';

/** 维修单状态（与 asset 模块 Prisma enum 对齐） */
export type RepairStatus = 'PENDING' | 'REPAIRING' | 'CANCELLED' | 'COMPLETED';

/** 维修登记（asset PRD §4：仅闲置/使用中资产可登记；报修时间默认当前时间；幂等） */
export class RepairOrderCreateDto extends IdempotentDto {
  @ApiProperty({ description: '资产 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  assetId!: number;

  @ApiProperty({ description: '故障/维修事项', maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  faultDescription!: string;

  @ApiProperty({
    description: '报修时间（RFC 3339；缺省为当前时间）',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsValidatedBy(isRfc3339Utc, { message: '必须是带时区的 RFC 3339 时间字符串' })
  reportedAt?: string;
}

/** 取消登记（幂等键通道；无业务字段） */
export class RepairCancelDto extends IdempotentDto {}

/** 开始维修（待维修 → 维修中；记录开始时间） */
export class RepairStartDto extends IdempotentDto {
  @ApiProperty({ description: '开始维修时间（RFC 3339；缺省为当前时间）', required: false })
  @IsOptional()
  @IsString()
  @IsValidatedBy(isRfc3339Utc, { message: '必须是带时区的 RFC 3339 时间字符串' })
  startedAt?: string;
}

/** 维修完成（维修中 → 已完成；填写结果、实际费用并选择恢复状态） */
export class RepairCompleteDto extends IdempotentDto {
  @ApiProperty({ description: '维修结果', maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  result!: string;

  @ApiProperty({ description: '实际费用（元，无费用为 0；最多两位小数）', example: '0' })
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '费用必须是 ≥ 0 且最多两位小数的十进制字符串' })
  actualCost!: string;

  @ApiProperty({
    description: '完成后资产恢复状态（使用中 / 闲置）',
    enum: ['IN_USE', 'IDLE'],
  })
  @IsIn(['IN_USE', 'IDLE'])
  postStatus!: 'IN_USE' | 'IDLE';

  @ApiProperty({ description: '完成时间（RFC 3339；缺省为当前时间）', required: false })
  @IsOptional()
  @IsString()
  @IsValidatedBy(isRfc3339Utc, { message: '必须是带时区的 RFC 3339 时间字符串' })
  completedAt?: string;
}

/** 维修单查询 */
export class RepairOrderQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '资产 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  assetId?: number;

  @ApiProperty({
    description: '维修单状态',
    required: false,
    enum: ['PENDING', 'REPAIRING', 'CANCELLED', 'COMPLETED'],
  })
  @IsOptional()
  @IsIn(['PENDING', 'REPAIRING', 'CANCELLED', 'COMPLETED'])
  status?: RepairStatus;
}

/** 维修流转历史查询参数（时间上限） */
export class RepairActionQueryDto {
  @ApiProperty({ description: '时间上限（YYYY-MM-DD，含当日）', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '日期格式必须为 YYYY-MM-DD' })
  until?: string;
}

/** 导出类型（维修历史导出复用） */
export type { AssetStatus };
