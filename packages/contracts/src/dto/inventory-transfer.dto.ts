import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { transformPositiveInt } from './strict-number';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from './base.dto';

/**
 * 轻量库存调拨（asset PRD §6：单次只处理一个来源库存条目，目标库位必选，
 * 数量为正整数；事务内重新计算可用库存，超限 CONFLICT；不可编辑删除）。
 *
 * 写接口必须携带稳定幂等键（asset PRD §6）：网络超时重试时防止重复移库。
 */
export class InventoryTransferCreateDto {
  @ApiProperty({ description: '本次调拨意图的幂等键；网络重试时必须保持不变', maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  idempotencyKey!: string;

  @ApiProperty({ description: '来源库存条目 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromInventoryItemId!: number;

  @ApiProperty({ description: '目标库位 id（必须启用且不同于来源库位）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toWarehouseId!: number;

  @ApiProperty({ description: '调拨数量（正整数）', minimum: 1 })
  @Transform(transformPositiveInt)
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiProperty({ description: '备注', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/** 调拨记录查询（默认按时间倒序） */
export class InventoryTransferQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '品种 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  consumableId?: number;

  @ApiProperty({ description: '规格（精确）', required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  spec?: string;

  @ApiProperty({ description: '来源库位 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromWarehouseId?: number;

  @ApiProperty({ description: '目标库位 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toWarehouseId?: number;

  @ApiProperty({ description: '操作者 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  operatorId?: number;
}
