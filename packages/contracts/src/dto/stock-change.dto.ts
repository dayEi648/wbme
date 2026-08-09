import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { transformPositiveInt } from './strict-number';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
} from 'class-validator';
import { isRfc3339Utc } from '../time';
import { IdempotentDto, PaginationQueryDto } from './base.dto';

/** 库存变更申请明细行（asset PRD §6：仅意外扣减；同一库存条目整单只能出现一次） */
export class StockChangeRequestItemDto {
  @ApiProperty({ description: '库存条目 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  inventoryItemId!: number;

  @ApiProperty({ description: '变更类型（字典项 id；库存变更类型仅表示意外扣减原因）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  changeTypeId!: number;

  @ApiProperty({ description: '具体原因（必填）', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ description: '扣减数量（正整数）', minimum: 1 })
  @Transform(transformPositiveInt)
  @IsInt()
  @Min(1)
  qty!: number;
}

/** 库存变更申请提交（清单式；仅处理非正常领用造成的意外扣减；批准后按批次扣减并生成流水） */
export class StockChangeRequestCreateDto extends IdempotentDto {
  @ApiProperty({ description: '变更明细行（同一库存条目整单只能一次）', type: [StockChangeRequestItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StockChangeRequestItemDto)
  items!: StockChangeRequestItemDto[];

  @ApiProperty({ description: '整单变更时间（RFC 3339；缺省提交时）', required: false })
  @IsOptional()
  @IsString()
  @Validate((value: string) => isRfc3339Utc(value), { message: '必须是带时区的 RFC 3339 时间字符串' })
  changedAt?: string;

  @ApiProperty({ description: '整单备注', required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

/** 库存变更申请历史查询（本人随「库存变更申请」权限隐含；范围历史由「库存变更申请历史记录」权限提供） */
export class StockChangeRequestQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '审批状态', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

  @ApiProperty({ description: '发起人姓名', required: false, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  applicantName?: string;
}
