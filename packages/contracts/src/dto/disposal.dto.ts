import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { transformPositiveInt } from './strict-number';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsDateString } from 'class-validator';
import { PaginationQueryDto } from './base.dto';

/** 注销员工借还直接处置明细行（asset PRD §8：不创建申请、不进入待审批；确认成功即最终业务结果） */
export class DirectDisposalItemDto {
  @ApiProperty({ description: '借还记录 id（PERSONAL 处置的每条记录）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  borrowRecordId!: number;

  @ApiProperty({ description: '处理方式（个人处置：正常归还 / 遗失损坏核销）', enum: ['RETURN', 'WRITE_OFF'] })
  @IsIn(['RETURN', 'WRITE_OFF'])
  method!: 'RETURN' | 'WRITE_OFF';

  @ApiProperty({ description: '核销类型（method=WRITE_OFF 必填）', required: false, enum: ['LOST', 'DAMAGED'] })
  @ValidateIf((dto: DirectDisposalItemDto) => dto.method === 'WRITE_OFF')
  @IsIn(['LOST', 'DAMAGED'])
  writeOffType?: 'LOST' | 'DAMAGED';

  @ApiProperty({ description: '核销原因（必填）/归还备注（可选）', required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty({ description: '处理数量（正整数；不得超过可处理数量）', minimum: 1 })
  @Transform(transformPositiveInt)
  @IsInt()
  @Min(1)
  qty!: number;
}

/** 代领共享清单直接整单结清明细行（发起人已注销且清单无待审批结清时使用；必须覆盖全部未结清数量） */
export class AgentSettleDisposalItemDto {
  @ApiProperty({ description: '清单级代领借还记录 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  borrowRecordId!: number;

  @ApiProperty({ description: '处理方式', enum: ['RETURN', 'WRITE_OFF'] })
  @IsIn(['RETURN', 'WRITE_OFF'])
  method!: 'RETURN' | 'WRITE_OFF';

  @ApiProperty({ description: '核销类型（method=WRITE_OFF 必填）', required: false, enum: ['LOST', 'DAMAGED'] })
  @ValidateIf((dto: AgentSettleDisposalItemDto) => dto.method === 'WRITE_OFF')
  @IsIn(['LOST', 'DAMAGED'])
  writeOffType?: 'LOST' | 'DAMAGED';

  @ApiProperty({ description: '核销原因 / 归还备注', required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty({ description: '该处理方式数量（正整数）', minimum: 1 })
  @Transform(transformPositiveInt)
  @IsInt()
  @Min(1)
  qty!: number;
}

/**
 * 注销员工借还直接处置提交（asset PRD §8/§9：审批中心「注销员工借还处置」功能；
 * 直接归还在事务中回库+流水，直接核销不回库；必须携带幂等键语义）。
 */
export class DirectDisposalDto {
  @ApiProperty({ description: '本次处置意图的幂等键；网络重试时必须保持不变', maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  idempotencyKey!: string;

  @ApiProperty({ description: '处置类型', enum: ['RETURN', 'WRITE_OFF', 'AGENT_SETTLE'] })
  @IsIn(['RETURN', 'WRITE_OFF', 'AGENT_SETTLE'])
  disposalType!: 'RETURN' | 'WRITE_OFF' | 'AGENT_SETTLE';

  @ApiProperty({ description: '个人借还处置明细（disposalType=RETURN/WRITE_OFF）', required: false, type: [DirectDisposalItemDto] })
  @ValidateIf((dto: DirectDisposalDto) => dto.disposalType !== 'AGENT_SETTLE')
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DirectDisposalItemDto)
  items?: DirectDisposalItemDto[];

  @ApiProperty({ description: '代领清单申请 id（disposalType=AGENT_SETTLE）', required: false, minimum: 1 })
  @ValidateIf((dto: DirectDisposalDto) => dto.disposalType === 'AGENT_SETTLE')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  agentRequestId?: number;

  @ApiProperty({ description: '代领整单结清明细（disposalType=AGENT_SETTLE）', required: false, type: [AgentSettleDisposalItemDto] })
  @ValidateIf((dto: DirectDisposalDto) => dto.disposalType === 'AGENT_SETTLE')
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AgentSettleDisposalItemDto)
  agentItems?: AgentSettleDisposalItemDto[];
}

/** 注销员工借还处置查询（待处置 / 处置记录两个视图） */
export class DisposalQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '视图：PENDING=待处置 / RECORDS=处置记录', enum: ['PENDING', 'RECORDS'], default: 'PENDING' })
  @IsIn(['PENDING', 'RECORDS'])
  tab: 'PENDING' | 'RECORDS' = 'PENDING';

  @ApiProperty({ description: '记录类型', required: false, enum: ['PERSONAL', 'AGENT'] })
  @IsOptional()
  @IsIn(['PERSONAL', 'AGENT'])
  recordType?: 'PERSONAL' | 'AGENT';

  @ApiProperty({ description: '处理方式', required: false, enum: ['RETURN', 'WRITE_OFF', 'AGENT_SETTLE'] })
  @IsOptional()
  @IsIn(['RETURN', 'WRITE_OFF', 'AGENT_SETTLE'])
  disposalType?: 'RETURN' | 'WRITE_OFF' | 'AGENT_SETTLE';

  @ApiProperty({ description: '处理人姓名', required: false, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processorName?: string;

  @ApiProperty({ description: '借用人 / 代交人姓名', required: false, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  userName?: string;

  @ApiProperty({ description: '处理时间范围起（含，ISO 日期时间）', required: false })
  @IsOptional()
  @IsDateString()
  createdAtFrom?: string;

  @ApiProperty({ description: '处理时间范围止（含，ISO 日期时间）', required: false })
  @IsOptional()
  @IsDateString()
  createdAtTo?: string;
}
