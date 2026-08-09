import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { isNonNegativeAmount } from '../money';
import { BATCH_LIMIT, IdempotentDto, IsValidatedBy, PaginationQueryDto } from './base.dto';

/** 资产使用状态（与 asset 模块 Prisma enum 对齐） */
export type AssetStatus = 'IDLE' | 'IN_USE' | 'PENDING_REPAIR' | 'REPAIRING' | 'SCRAPPED';

/** 资产归属（与 asset 模块 Prisma enum 对齐） */
export type AssetOwnership = 'COMPANY' | 'PARTNER';

/** 自然日（YYYY-MM-DD） */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 批量删除通用校验：1～100 个互不重复的目标标识（主 PRD §9.5） */
function assertBatchIds(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1;
}

/** 资产建档（asset PRD §4：金额必填；主图可选，经图片上传后提交对象标识；幂等） */
export class AssetCreateDto extends IdempotentDto {
  @ApiProperty({ description: '资产名称', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: '分类 id（固定资产分类下的一级子类）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiProperty({ description: '规格型号', required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  specModel?: string;

  @ApiProperty({ description: '金额（元，最多两位小数；必填）', example: '1234.50' })
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '金额必须是 ≥ 0 且最多两位小数的十进制字符串' })
  amount!: string;

  @ApiProperty({ description: '入库时间（YYYY-MM-DD）', required: false })
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: '日期格式必须为 YYYY-MM-DD' })
  purchaseAt?: string;

  @ApiProperty({ description: '资产归属', enum: ['COMPANY', 'PARTNER'] })
  @IsIn(['COMPANY', 'PARTNER'])
  ownership!: AssetOwnership;

  @ApiProperty({ description: '归属方名称（合作方所有时必填）', required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ownerName?: string;

  @ApiProperty({ description: '所属部门 id（可空；部门删除时自动置空）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @ApiProperty({ description: '责任人 id（与所属部门必须匹配；变化须经调度接口）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  responsibleUserId?: number;

  @ApiProperty({ description: '使用者 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  currentUserId?: number;

  @ApiProperty({ description: '主图对象标识（图片上传返回的 OSS key）', required: false, maxLength: 200 })
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
 * 资产基础资料编辑（asset PRD §4）。
 * 责任人与所属部门不在普通编辑内（必须走调度接口产生调度记录）；普通编辑只允许
 * 在 IDLE/IN_USE 互切，或把已报废恢复为 IDLE/IN_USE（记录状态变更前后值与操作人）。
 */
export class AssetUpdateDto {
  @ApiProperty({ description: '资产名称', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: '分类 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiProperty({ description: '规格型号', required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  specModel?: string;

  @ApiProperty({ description: '金额（元，最多两位小数）', example: '1234.50' })
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '金额必须是 ≥ 0 且最多两位小数的十进制字符串' })
  amount!: string;

  @ApiProperty({ description: '入库时间（YYYY-MM-DD）', required: false })
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: '日期格式必须为 YYYY-MM-DD' })
  purchaseAt?: string;

  @ApiProperty({ description: '资产归属', enum: ['COMPANY', 'PARTNER'] })
  @IsIn(['COMPANY', 'PARTNER'])
  ownership!: AssetOwnership;

  @ApiProperty({ description: '归属方名称（合作方所有时必填）', required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ownerName?: string;

  @ApiProperty({ description: '使用者 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  currentUserId?: number;

  @ApiProperty({ description: '主图对象标识', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  imageOssKey?: string;

  @ApiProperty({ description: '备注', required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  @ApiProperty({
    description: '使用状态（仅允许 IDLE/IN_USE 互切，或把 SCRAPPED 恢复为 IDLE/IN_USE；待维修/维修中由维修管理驱动）',
    enum: ['IDLE', 'IN_USE'],
  })
  @IsIn(['IDLE', 'IN_USE'])
  usageStatus!: 'IDLE' | 'IN_USE';
}

/** 调度（asset PRD §4：责任人和所属部门变化必须产生调度记录；目标责任人必须属于目标部门） */
export class AssetScheduleDto {
  @ApiProperty({ description: '目标所属部门 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toDepartmentId!: number;

  @ApiProperty({ description: '目标责任人 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toUserId!: number;

  @ApiProperty({ description: '调度备注', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/** 报废（asset PRD §4：业务状态而非删除；二次确认） */
export class AssetScrapDto {
  @ApiProperty({ description: '二次确认标志（必须为 true）' })
  @IsBoolean()
  confirm!: boolean;
}

/** 批量软删除（asset PRD §4：仍在使用或有业务关联的资产整批拒绝） */
export class AssetBatchDeleteDto {
  @ApiProperty({ description: '资产 id 列表（1～100 个，不重复）', type: [Number] })
  @IsArray()
  @IsValidatedBy(assertBatchIds, { message: '至少需要 1 个资产 id' })
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];
}

/** 固定资产台账查询（固定资产查看/维护，部门/公司档） */
export class AssetQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '分类 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiProperty({ description: '所属部门 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @ApiProperty({ description: '使用状态', required: false, enum: ['IDLE', 'IN_USE', 'PENDING_REPAIR', 'REPAIRING', 'SCRAPPED'] })
  @IsOptional()
  @IsIn(['IDLE', 'IN_USE', 'PENDING_REPAIR', 'REPAIRING', 'SCRAPPED'])
  usageStatus?: AssetStatus;

  @ApiProperty({ description: '资产归属', required: false, enum: ['COMPANY', 'PARTNER'] })
  @IsOptional()
  @IsIn(['COMPANY', 'PARTNER'])
  ownership?: AssetOwnership;

  @ApiProperty({ description: '责任人 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  responsibleUserId?: number;

  @ApiProperty({ description: '使用者 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  currentUserId?: number;

  @ApiProperty({ description: '关键字（名称/规格型号模糊）', required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;
}

/** 我的资产查询（本人档：责任人或使用者为当前用户；按「我负责的 / 我使用的 / 全部」筛选） */
export class MyAssetQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '筛选维度', enum: ['OWNED', 'USED', 'ALL'], default: 'ALL' })
  @IsIn(['OWNED', 'USED', 'ALL'])
  scope: 'OWNED' | 'USED' | 'ALL' = 'ALL';

  @ApiProperty({ description: '使用状态', required: false, enum: ['IDLE', 'IN_USE', 'PENDING_REPAIR', 'REPAIRING', 'SCRAPPED'] })
  @IsOptional()
  @IsIn(['IDLE', 'IN_USE', 'PENDING_REPAIR', 'REPAIRING', 'SCRAPPED'])
  usageStatus?: AssetStatus;
}
