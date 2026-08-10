import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { IdempotentDto, PaginationQueryDto } from './base.dto';

/** 二维码目标类型（与 asset 模块 Prisma enum 对齐） */
export type QrTargetType = 'ASSET' | 'INVENTORY_ITEM' | 'SCAN_CATALOG';

/** 二维码创建（asset PRD §11：固定资产归「固定资产维护」；库存条目与申领目录归「消耗品库存管理」） */
export class QrCodeCreateDto extends IdempotentDto {
  @ApiProperty({ description: '目标类型', enum: ['ASSET', 'INVENTORY_ITEM', 'SCAN_CATALOG'] })
  @IsIn(['ASSET', 'INVENTORY_ITEM', 'SCAN_CATALOG'])
  targetType!: QrTargetType;

  @ApiProperty({ description: '目标标识（SCAN_CATALOG 为 null）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetId?: number;
}

/** 二维码管理动作（停用 / 恢复 / 作废并重新生成；REVOKED 终态不可恢复） */
export class QrActionDto extends IdempotentDto {
  @ApiProperty({ description: '动作', enum: ['DISABLE', 'ENABLE', 'REGENERATE'] })
  @IsIn(['DISABLE', 'ENABLE', 'REGENERATE'])
  action!: 'DISABLE' | 'ENABLE' | 'REGENERATE';
}

/** 扫码解析（asset PRD §11：公开标识经前端 fragment 读取后提交；接口限流；日志不得记录完整标识） */
export class QrParseDto {
  @ApiProperty({ description: '二维码公开标识（来自 /scan#<publicId> fragment；解析后立即从地址栏移除）', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  publicId!: string;
}

/** 二维码查询 */
export class QrCodeQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '目标类型', required: false, enum: ['ASSET', 'INVENTORY_ITEM', 'SCAN_CATALOG'] })
  @IsOptional()
  @IsIn(['ASSET', 'INVENTORY_ITEM', 'SCAN_CATALOG'])
  targetType?: QrTargetType;

  @ApiProperty({ description: '目标标识（按目标筛选，如资产详情展示二维码）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetId?: number;

  @ApiProperty({ description: '状态', required: false, enum: ['ACTIVE', 'DISABLED', 'REVOKED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED', 'REVOKED'])
  status?: 'ACTIVE' | 'DISABLED' | 'REVOKED';
}
