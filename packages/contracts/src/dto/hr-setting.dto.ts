import { ApiProperty } from '@nestjs/swagger';
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

/** 更新单条人事设置（值按 value_type 校验：全部为数值） */
export class HrSettingUpdateDto extends IdempotentDto {
  @ApiProperty({
    description: '设置值（字符串表达；按 value_type 校验，全部为数值）',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  value!: string;
}

/** 人事字典类型（与 hr 模块 Prisma enum 对齐；MVP 仅保留占位类型，业务引入时同步扩展） */
export const HR_DICT_TYPES = ['PLACEHOLDER'] as const;

/** 创建字典项 */
export class HrDictCreateDto extends IdempotentDto {
  @ApiProperty({
    description: '字典类型编码',
    enum: HR_DICT_TYPES,
  })
  @IsIn(HR_DICT_TYPES)
  dictType!: (typeof HR_DICT_TYPES)[number];

  @ApiProperty({
    description: '字典项名称',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: '同级排序（越小越靠前）',
    required: false,
    minimum: 0,
    maximum: 9999,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

/** 更新字典项（名称/排序/启停） */
export class HrDictUpdateDto extends IdempotentDto {
  @ApiProperty({
    description: '字典项名称',
    required: false,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({
    description: '同级排序（越小越靠前）',
    required: false,
    minimum: 0,
    maximum: 9999,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;

  @ApiProperty({
    description: '启停状态',
    required: false,
    enum: ['ACTIVE', 'DISABLED'],
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

/** 字典列表查询 */
export class HrDictQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '字典类型过滤',
    required: false,
    enum: HR_DICT_TYPES,
  })
  @IsOptional()
  @IsIn(HR_DICT_TYPES)
  dictType?: (typeof HR_DICT_TYPES)[number];

  @ApiProperty({
    description: '启停状态',
    required: false,
    enum: ['ACTIVE', 'DISABLED'],
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

/** 批量硬删除字典项（主 PRD §2.6 确认式删除：引用预览后确认执行，不整批拒绝；§9.5 批量操作幂等） */
export class HrDictDeleteDto extends IdempotentDto {
  @ApiProperty({
    description: `字典项 id 列表（1-${BATCH_LIMIT} 个，互不重复）`,
    type: 'array',
    items: { type: 'number' },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  ids!: number[];
}
