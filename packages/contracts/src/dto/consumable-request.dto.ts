import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { transformPositiveInt } from './strict-number';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IdempotentDto, PaginationQueryDto } from './base.dto';

/** 申领清单明细行（普通申领：同一库存条目只能出现一次；用途必填） */
export class ConsumableRequestItemDto {
  @ApiProperty({ description: '库存条目 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  inventoryItemId!: number;

  @ApiProperty({ description: '数量（正整数）', minimum: 1 })
  @Transform(transformPositiveInt)
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiProperty({ description: '用途（普通申领必填）', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  purpose!: string;
}

/** 普通申领提交（asset PRD §7：库存占用 + 个人额度占用原子；整单全有或全无） */
export class ConsumableRequestCreateDto extends IdempotentDto {
  @ApiProperty({ description: '申领明细行（同一库存条目整单只能一次）', type: [ConsumableRequestItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ConsumableRequestItemDto)
  items!: ConsumableRequestItemDto[];
}

/** 代交申领共享清单明细行（不按受领人分摊；代交清单可不填用途） */
export class AgentRequestItemDto {
  @ApiProperty({ description: '库存条目 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  inventoryItemId!: number;

  @ApiProperty({ description: '清单总数量（正整数；不按受领人分摊）', minimum: 1 })
  @Transform(transformPositiveInt)
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiProperty({ description: '用途（代交共享清单可空）', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  purpose?: string;
}

/**
 * 代交申领提交（asset PRD §7：受领人名单 + 一张共享物品清单；
 * 不能选择自己、不能重复；不占用任何个人额度；审批一次整单）。
 */
export class AgentRequestCreateDto extends IdempotentDto {
  @ApiProperty({ description: '受领人 id 列表（不能选择自己、不能重复；1～100 人）', type: [Number] })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  recipientIds!: number[];

  @ApiProperty({ description: '共享物品清单（同一库存条目整单只能一次）', type: [AgentRequestItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AgentRequestItemDto)
  items!: AgentRequestItemDto[];
}

/** 申领历史查询（本人随「消耗品申领」权限隐含；范围历史由「消耗品申领历史记录」权限提供） */
export class ConsumableRequestQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '申请类型', required: false, enum: ['CONSUMABLE_REQUEST', 'AGENT_REQUEST'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  requestType?: 'CONSUMABLE_REQUEST' | 'AGENT_REQUEST';

  @ApiProperty({ description: '审批状态', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

  @ApiProperty({ description: '发起人姓名（范围历史筛选）', required: false, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  applicantName?: string;
}
