import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BATCH_LIMIT, IdempotentDto, PaginationQueryDto } from './base.dto';

/**
 * 人事配置与字典 DTO（hr PRD §9）。
 * 运行参数（加班提前申请/补交窗口）与人事字典（机制保留，字典项随业务引入）。
 */

/** 更新单条人事设置（值按 value_type 校验：本期全部为数值） */
export class HrSettingUpdateDto extends IdempotentDto {
  @IsString()
  @MaxLength(100)
  value!: string;
}

/** 创建字典项 */
export class HrDictCreateDto extends IdempotentDto {
  @IsString()
  @MaxLength(50)
  dictType!: string;

  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

/** 更新字典项（名称/排序/启停） */
export class HrDictUpdateDto extends IdempotentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

/** 字典列表查询 */
export class HrDictQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  dictType?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

/** 批量硬删除字典项（未被引用时；任一被引用整批拒绝，hr PRD §9） */
export class HrDictDeleteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  ids!: number[];
}
