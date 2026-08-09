import { IsObject, IsString, MaxLength } from 'class-validator';

/**
 * 用户表格偏好 DTO（主 PRD §10.2 / T4-12）。
 * 从 platform-core 上移至共享契约：platform-core（B-5）与 asset/hr/fin（同构表）共用同一契约。
 */

/** 列设置内容 */
export class ColumnSettingDto {
  @IsObject()
  content!: Record<string, unknown>;
}

/** 筛选预设 */
export class FilterPresetDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsObject()
  content!: Record<string, unknown>;
}

/** 重命名筛选预设 */
export class RenameFilterPresetDto {
  @IsString()
  @MaxLength(100)
  name!: string;
}
