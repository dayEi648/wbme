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
  Validate,
} from 'class-validator';
import { BATCH_LIMIT, PaginationQueryDto } from './base.dto';

/** 分类状态（与 asset 模块 Prisma enum 对齐） */
export type DictStatus = 'ACTIVE' | 'DISABLED';

/** 业务字典类型（与 asset 模块 Prisma enum 对齐） */
export type AssetDictType =
  | 'UNIT'
  | 'CHANGE_TYPE'
  | 'SUPPLIER'
  | 'BRAND'
  | 'SPEC'
  | 'ASSET_SPEC'
  | 'ASSET_MODEL';

/** 批量删除通用校验：1～100 个互不重复的目标标识（主 PRD §9.5） */
function assertBatchIds(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1;
}

/** 分类创建 */
export class AssetCategoryCreateDto {
  @ApiProperty({ description: '父分类 id（顶级分类为 null；业务只维护一级子分类）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  parentId?: number;

  @ApiProperty({ description: '分类名称', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiProperty({ description: '排序（小的在前）', required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort: number = 0;
}

/** 分类编辑 */
export class AssetCategoryUpdateDto {
  @ApiProperty({ description: '分类名称', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiProperty({ description: '排序（小的在前）', required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort: number = 0;

  @ApiProperty({ description: '状态', enum: ['ACTIVE', 'DISABLED'] })
  @IsIn(['ACTIVE', 'DISABLED'])
  status!: DictStatus;
}

/** 分类批量硬删除（任一项被引用则整批回滚，asset PRD §3） */
export class AssetCategoryBatchDeleteDto {
  @ApiProperty({ description: '分类 id 列表（1～100 个，不重复）', type: [Number] })
  @IsArray()
  @Validate(assertBatchIds, { message: '至少需要 1 个分类 id' })
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];
}

/** 分类查询（默认返回全部，可用状态过滤） */
export class AssetCategoryQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '状态过滤', required: false, enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: DictStatus;
}

/** 字典项创建 */
export class AssetDictItemCreateDto {
  @ApiProperty({
    description: '字典类型',
    enum: ['UNIT', 'CHANGE_TYPE', 'SUPPLIER', 'BRAND', 'SPEC', 'ASSET_SPEC', 'ASSET_MODEL'],
  })
  @IsIn(['UNIT', 'CHANGE_TYPE', 'SUPPLIER', 'BRAND', 'SPEC', 'ASSET_SPEC', 'ASSET_MODEL'])
  dictType!: AssetDictType;

  @ApiProperty({ description: '字典项名称', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiProperty({ description: '排序（小的在前）', required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort: number = 0;
}

/** 字典项编辑 */
export class AssetDictItemUpdateDto {
  @ApiProperty({ description: '字典项名称', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiProperty({ description: '排序（小的在前）', required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort: number = 0;

  @ApiProperty({ description: '状态', enum: ['ACTIVE', 'DISABLED'] })
  @IsIn(['ACTIVE', 'DISABLED'])
  status!: DictStatus;
}

/** 字典项批量硬删除（任一项被引用则整批回滚，asset PRD §12） */
export class AssetDictItemBatchDeleteDto {
  @ApiProperty({ description: '字典项 id 列表（1～100 个，不重复）', type: [Number] })
  @IsArray()
  @Validate(assertBatchIds, { message: '至少需要 1 个字典项 id' })
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];
}

/** 字典项查询 */
export class AssetDictItemQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '字典类型过滤',
    required: false,
    enum: ['UNIT', 'CHANGE_TYPE', 'SUPPLIER', 'BRAND', 'SPEC', 'ASSET_SPEC', 'ASSET_MODEL'],
  })
  @IsOptional()
  @IsIn(['UNIT', 'CHANGE_TYPE', 'SUPPLIER', 'BRAND', 'SPEC', 'ASSET_SPEC', 'ASSET_MODEL'])
  dictType?: AssetDictType;

  @ApiProperty({ description: '状态过滤', required: false, enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: DictStatus;
}
