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
} from 'class-validator';
import { BATCH_LIMIT, IsValidatedBy, PaginationQueryDto } from './base.dto';

/** 通用校验：1～100 个互不重复的目标标识（主 PRD §9.5） */
function assertBatchIds(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1;
}

/** 库位创建（asset PRD §5：全公司统一层级库位树；禁止形成父子循环） */
export class WarehouseCreateDto {
  @ApiProperty({ description: '父库位 id（null=根）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  parentId?: number;

  @ApiProperty({ description: '库位名称', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiProperty({ description: '排序（小的在前）', required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort: number = 0;
}

/** 库位编辑（改名/移动节点只影响当前树，历史快照不追溯改写） */
export class WarehouseUpdateDto {
  @ApiProperty({ description: '父库位 id（null=移动到根）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  parentId?: number;

  @ApiProperty({ description: '库位名称', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiProperty({ description: '排序（小的在前）', required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort: number = 0;

  @ApiProperty({ description: '状态（停用后不能作为新入库或调拨目标）', enum: ['ACTIVE', 'DISABLED'] })
  @IsIn(['ACTIVE', 'DISABLED'])
  status!: 'ACTIVE' | 'DISABLED';
}

/** 库位批量硬删除（存在未删除子库位或现存库存/未结清借还/待审批引用时整批拒绝） */
export class WarehouseBatchDeleteDto {
  @ApiProperty({ description: '库位 id 列表（1～100 个，不重复）', type: [Number] })
  @IsArray()
  @IsValidatedBy(assertBatchIds, { message: '至少需要 1 个库位 id' })
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];
}

/** 库位查询（树形全量返回，可状态过滤） */
export class WarehouseQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '状态过滤', required: false, enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}
