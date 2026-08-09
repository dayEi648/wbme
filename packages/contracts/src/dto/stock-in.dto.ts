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
import { isNonNegativeAmount } from '../money';
import { isRfc3339Utc } from '../time';
import { IdempotentDto, PaginationQueryDto } from './base.dto';

/** 入库申请明细行（asset PRD §6：品种 + 供应商/品牌/规格/库位 + 数量 + 可选单价） */
export class StockInRequestItemDto {
  @ApiProperty({ description: '品种 id（必须启用）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  consumableId!: number;

  @ApiProperty({ description: '供应商（字典项 id）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;

  @ApiProperty({ description: '品牌（字典项 id）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  brandId?: number;

  @ApiProperty({ description: '规格', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  spec!: string;

  @ApiProperty({ description: '目标库位 id（必须启用）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId!: number;

  @ApiProperty({ description: '数量（正整数）', minimum: 1 })
  @Transform(transformPositiveInt)
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiProperty({ description: '单价（元，最多两位小数；可空）', required: false, example: '10.00' })
  @IsOptional()
  @IsString()
  @Validate((value: string) => isNonNegativeAmount(value), { message: '单价必须是 ≥ 0 且最多两位小数的十进制字符串' })
  unitPrice?: string;
}

/** 入库申请提交（清单式；整单审批；批准后按行形成批次并增加库存） */
export class StockInRequestCreateDto extends IdempotentDto {
  @ApiProperty({ description: '入库明细行（同一品种+规格+库位只能一行）', type: [StockInRequestItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StockInRequestItemDto)
  items!: StockInRequestItemDto[];

  @ApiProperty({ description: '整单申请时间（RFC 3339；缺省提交时；批准后作为批次入库时间）', required: false })
  @IsOptional()
  @IsString()
  @Validate((value: string) => isRfc3339Utc(value), { message: '必须是带时区的 RFC 3339 时间字符串' })
  receivedAt?: string;

  @ApiProperty({ description: '整单备注', required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

/** 入库申请历史查询（本人随「入库申请」权限隐含；范围历史由「入库申请历史记录」权限提供） */
export class StockInRequestQueryDto extends PaginationQueryDto {
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
