import { IsObject, IsString, MaxLength } from 'class-validator';

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
