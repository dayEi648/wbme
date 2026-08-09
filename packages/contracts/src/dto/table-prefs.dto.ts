import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString, MaxLength } from 'class-validator';

/**
 * 用户表格偏好 DTO（主 PRD §10.2）。
 * 从 platform-core 上移至共享契约：platform-core（B-5）与 asset/hr/fin（同构表）共用同一契约。
 */

/** 列设置内容 */
export class ColumnSettingDto {
  @ApiProperty({
    description: '列设置内容（列显隐/宽度/顺序等，结构由前端定义）',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  content!: Record<string, unknown>;
}

/** 筛选预设 */
export class FilterPresetDto {
  @ApiProperty({
    description: '预设名称',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: '筛选条件内容（结构由前端定义）',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  content!: Record<string, unknown>;
}

/** 重命名筛选预设 */
export class RenameFilterPresetDto {
  @ApiProperty({
    description: '预设新名称',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  name!: string;
}
