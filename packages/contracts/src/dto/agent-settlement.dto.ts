import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IdempotentDto, PaginationQueryDto } from './base.dto';

/** 代领结清明细行（asset PRD §7：一次性整单结清；每种物品各处理方式数量之和必须等于全部未结清数量） */
export class AgentSettlementItemDto {
  @ApiProperty({ description: '清单级代领借还记录 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  borrowRecordId!: number;

  @ApiProperty({ description: '处理方式', enum: ['RETURN', 'WRITE_OFF'] })
  @IsIn(['RETURN', 'WRITE_OFF'])
  method!: 'RETURN' | 'WRITE_OFF';

  @ApiProperty({ description: '核销类型（遗失/损坏；method=WRITE_OFF 必填）', required: false, enum: ['LOST', 'DAMAGED'] })
  @ValidateIf((dto: AgentSettlementItemDto) => dto.method === 'WRITE_OFF')
  @IsIn(['LOST', 'DAMAGED'])
  writeOffType?: 'LOST' | 'DAMAGED';

  @ApiProperty({ description: '核销原因 / 归还备注', required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty({ description: '该处理方式数量（正整数）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;
}

/** 代领结清提交（同一代领清单最多一条待审批结清申请；驳回/取消后可重新提交覆盖全部未结清数量的新结清单） */
export class AgentSettlementCreateDto extends IdempotentDto {
  @ApiProperty({ description: '代领申领申请 id（AGENT_REQUEST）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  refRequestId!: number;

  @ApiProperty({ description: '结清明细行', type: [AgentSettlementItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AgentSettlementItemDto)
  items!: AgentSettlementItemDto[];
}

/** 代领结清申请查询 */
export class AgentSettlementQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '审批状态', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
}
