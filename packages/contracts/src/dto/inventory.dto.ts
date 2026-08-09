import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min, Validate } from 'class-validator';
import { isNonNegativeAmount } from '../money';
import { PaginationQueryDto } from './base.dto';

/** 库存条目查询（消耗品库存管理） */
export class InventoryItemQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '品种 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  consumableId?: number;

  @ApiProperty({ description: '库位 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;

  @ApiProperty({ description: '规格（精确）', required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  spec?: string;

  @ApiProperty({ description: '仅显示低库存品种（可用 < 安全库存）', required: false })
  @IsOptional()
  @Type(() => Boolean)
  lowStockOnly?: boolean;
}

/** 批次查询 */
export class BatchQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '库存条目 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  inventoryItemId?: number;

  @ApiProperty({ description: '品种 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  consumableId?: number;

  @ApiProperty({ description: '库位 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;
}

/**
 * 批次纠正（asset PRD §5：供应商/品牌/单价/备注直接纠正并记录前后值；
 * 规格/库位会改变条目归属，仅当批次无后续流水且来源条目无待审批占用时可纠正）。
 */
export class BatchCorrectionDto {
  @ApiProperty({ description: '纠正原因（必填）', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ description: '供应商（字典项 id）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;

  @ApiProperty({ description: '品牌（字典项 id）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  brandId?: number;

  @ApiProperty({ description: '单价（元，最多两位小数）', required: false, example: '10.00' })
  @IsOptional()
  @IsString()
  @Validate((value: string) => isNonNegativeAmount(value), { message: '单价必须是 ≥ 0 且最多两位小数的十进制字符串' })
  unitPrice?: string;

  @ApiProperty({ description: '批次备注', required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  @ApiProperty({ description: '规格（可空：不纠正规格；非空且无后续流水时可纠正）', required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  spec?: string;

  @ApiProperty({ description: '目标库位 id（可空：不移动库位；非空且无后续流水时可纠正）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;
}

/** 库存流水类型（与 asset 模块 Prisma enum 对齐） */
export type StockFlowType =
  | 'STOCK_IN'
  | 'ISSUE'
  | 'DEDUCTION'
  | 'RETURN'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'CORRECTION';

/** 库存流水查询（只追加；导出复用同一 DTO） */
export class StockFlowQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '品种 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  consumableId?: number;

  @ApiProperty({ description: '库存条目 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  inventoryItemId?: number;

  @ApiProperty({ description: '库位 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;

  @ApiProperty({
    description: '流水类型',
    required: false,
    enum: ['STOCK_IN', 'ISSUE', 'DEDUCTION', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'CORRECTION'],
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  flowType?: StockFlowType;

  @ApiProperty({ description: '业务来源类型（申请/调拨/处置等）', required: false, maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  refType?: string;

  @ApiProperty({ description: '业务来源标识', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  refId?: number;
}
