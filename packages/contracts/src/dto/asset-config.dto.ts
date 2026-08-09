import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';

/** 运行参数键（asset PRD §12；A-28） */
export const ASSET_SETTING_KEY_SCAN_ENTRY_URL = 'asset.scan.entry.url';
export const ASSET_SETTING_KEY_QUOTA_RESET_DAY = 'asset.quota.reset.day';

/** 运行参数更新（整组提交；缺省字段保持现值） */
export class AssetSettingUpdateDto {
  @ApiProperty({
    description: '二维码扫码入口地址（前端 /scan 页面完整地址）',
    required: false,
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @IsUrl({ require_tld: false }, { message: '扫码入口必须是合法 URL' })
  @MaxLength(200)
  scanEntryUrl?: string;

  @ApiProperty({
    description: '申领上限重置日（1～28 号；保证每个自然月都存在该日；变更只影响之后开始的周期）',
    required: false,
    minimum: 1,
    maximum: 28,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  quotaResetDay?: number;
}

/** 运行参数值（读取响应项） */
export class AssetSettingItemDto {
  @ApiProperty({ description: '参数键' })
  key!: string;

  @ApiProperty({ description: '参数值' })
  value!: string;

  @ApiProperty({ description: '值类型', enum: ['STRING', 'NUMBER', 'BOOLEAN', 'JSON'] })
  valueType!: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON';

  @ApiProperty({ description: '参数名称' })
  label!: string;

  @ApiProperty({ description: '最后更新人 id', required: false })
  updatedBy?: number | null;

  @ApiProperty({ description: '最后更新时间' })
  updatedAt!: string;
}
