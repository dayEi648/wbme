import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { isNonNegativeAmount } from '../money';
import { BATCH_LIMIT, IdempotentDto, IsValidatedBy, PaginationQueryDto } from './base.dto';

/** 品种类型（与 asset 模块 Prisma enum 对齐；创建后不可变） */
export type ConsumableType = 'DISPOSABLE' | 'REUSABLE';

/** 申领上限周期（与 asset 模块 Prisma enum 对齐） */
export type QuotaCycle = 'MONTH' | 'QUARTER' | 'YEAR';

/** 通用校验：1～100 个互不重复的目标标识（主 PRD §9.5） */
function assertBatchIds(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1;
}

/** 品种创建（asset PRD §5：类型创建时确定不可变；一次性用品必填周期与上限，借还用品必填归还期限与同时持有上限） */
export class ConsumableCreateDto extends IdempotentDto {
  @ApiProperty({ description: '品种名称（删除后同名可再建）', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiProperty({ description: '分类 id（消耗品分类下的一级子类）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiProperty({ description: '单位（字典项 id）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  unitId?: number;

  @ApiProperty({ description: '品种类型', enum: ['DISPOSABLE', 'REUSABLE'] })
  @IsIn(['DISPOSABLE', 'REUSABLE'])
  type!: ConsumableType;

  @ApiProperty({ description: '申领上限周期（一次性用品必填）', required: false, enum: ['MONTH', 'QUARTER', 'YEAR'] })
  @ValidateIf((dto: ConsumableCreateDto) => dto.type === 'DISPOSABLE')
  @IsIn(['MONTH', 'QUARTER', 'YEAR'])
  quotaCycle?: QuotaCycle;

  @ApiProperty({ description: '周期内数量上限（一次性用品必填，≥1）', required: false, minimum: 1 })
  @ValidateIf((dto: ConsumableCreateDto) => dto.type === 'DISPOSABLE')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quotaLimit?: number;

  @ApiProperty({ description: '归还期限（天；借还用品必填，≥1）', required: false, minimum: 1 })
  @ValidateIf((dto: ConsumableCreateDto) => dto.type === 'REUSABLE')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  returnDays?: number;

  @ApiProperty({ description: '同时持有上限（借还用品必填，≥1）', required: false, minimum: 1 })
  @ValidateIf((dto: ConsumableCreateDto) => dto.type === 'REUSABLE')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxHolding?: number;

  @ApiProperty({ description: '参考单价（元，最多两位小数）', required: false, example: '10.00' })
  @IsOptional()
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '单价必须是 ≥ 0 且最多两位小数的十进制字符串' })
  referencePrice?: string;

  @ApiProperty({ description: '安全库存', required: false, default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  safetyStock: number = 0;

  @ApiProperty({ description: '图片对象标识（图片上传返回的 OSS key）', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  imageOssKey?: string;

  @ApiProperty({ description: '备注', required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

/**
 * 品种编辑（asset PRD §5：类型与单位不可变；品类参数随编辑一并维护，参数变化留下前后值；
 * 申领上限/归还期限/同时持有上限只影响之后新提交/新借出）。
 */
export class ConsumableUpdateDto extends IdempotentDto {
  @ApiProperty({ description: '品种名称', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiProperty({ description: '分类 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiProperty({ description: '申领上限周期（一次性用品必填）', required: false, enum: ['MONTH', 'QUARTER', 'YEAR'] })
  @ValidateIf((dto: ConsumableUpdateDto) => dto.type === 'DISPOSABLE')
  @IsIn(['MONTH', 'QUARTER', 'YEAR'])
  quotaCycle?: QuotaCycle;

  @ApiProperty({ description: '周期内数量上限（一次性用品必填）', required: false, minimum: 1 })
  @ValidateIf((dto: ConsumableUpdateDto) => dto.type === 'DISPOSABLE')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quotaLimit?: number;

  @ApiProperty({ description: '归还期限（天；借还用品必填）', required: false, minimum: 1 })
  @ValidateIf((dto: ConsumableUpdateDto) => dto.type === 'REUSABLE')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  returnDays?: number;

  @ApiProperty({ description: '同时持有上限（借还用品必填）', required: false, minimum: 1 })
  @ValidateIf((dto: ConsumableUpdateDto) => dto.type === 'REUSABLE')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxHolding?: number;

  @ApiProperty({ description: '参考单价（元，最多两位小数）', required: false, example: '10.00' })
  @IsOptional()
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '单价必须是 ≥ 0 且最多两位小数的十进制字符串' })
  referencePrice?: string;

  @ApiProperty({ description: '安全库存', minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  safetyStock!: number;

  @ApiProperty({ description: '图片对象标识', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  imageOssKey?: string;

  @ApiProperty({ description: '备注', required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  @ApiProperty({ description: '状态（停用后不可新建入库/申领，既有库存与待审批不受影响）', enum: ['ACTIVE', 'DISABLED'] })
  @IsIn(['ACTIVE', 'DISABLED'])
  status!: 'ACTIVE' | 'DISABLED';

  /** 编辑时携带的品种类型（服务端以既有类型为准校验参数一致性，不允许变更） */
  @ApiProperty({ description: '品种类型（只读语义；服务端以既有类型为准）', enum: ['DISPOSABLE', 'REUSABLE'] })
  @IsIn(['DISPOSABLE', 'REUSABLE'])
  type!: ConsumableType;
}

/** 品种批量硬删除（存在当前库存/未结清借还/待审批引用时整批拒绝；仅有历史终态引用时可确认删除） */
export class ConsumableBatchDeleteDto extends IdempotentDto {
  @ApiProperty({ description: '品种 id 列表（1～100 个，不重复）', type: [Number] })
  @IsArray()
  @IsValidatedBy(assertBatchIds, { message: '至少需要 1 个品种 id' })
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];
}

/** 品种查询 */
export class ConsumableQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '分类 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiProperty({ description: '品种类型', required: false, enum: ['DISPOSABLE', 'REUSABLE'] })
  @IsOptional()
  @IsIn(['DISPOSABLE', 'REUSABLE'])
  type?: ConsumableType;

  @ApiProperty({ description: '状态', required: false, enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @ApiProperty({ description: '关键字（名称模糊）', required: false, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;

  @ApiProperty({ description: '仅显示有可用库存的品种（申领目录）', required: false })
  @IsOptional()
  @Type(() => Boolean)
  hasAvailableStock?: boolean;
}
