import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IdempotentDto, PaginationQueryDto } from './base.dto';

/** 归还申请明细行（asset PRD §8：对未结清数量部分或全部归还） */
export class BorrowReturnItemDto {
  @ApiProperty({ description: '借还记录 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  borrowRecordId!: number;

  @ApiProperty({ description: '归还数量（正整数；不得超过可申请处理数量）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiProperty({ description: '归还备注', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/** 归还申请提交（提交后待确认数量仍计入持有量；由「消耗品审批」确认后回库） */
export class BorrowReturnCreateDto extends IdempotentDto {
  @ApiProperty({ description: '归还明细行（同一借还记录整单只能一次）', type: [BorrowReturnItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BorrowReturnItemDto)
  items!: BorrowReturnItemDto[];
}

/** 核销申请明细行（遗失/损坏核销：从持有量结清，不回库） */
export class BorrowWriteOffItemDto {
  @ApiProperty({ description: '借还记录 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  borrowRecordId!: number;

  @ApiProperty({ description: '核销数量（正整数）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiProperty({ description: '核销类型', enum: ['LOST', 'DAMAGED'] })
  @IsIn(['LOST', 'DAMAGED'])
  writeOffType!: 'LOST' | 'DAMAGED';

  @ApiProperty({ description: '核销原因（必填）', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

/** 核销申请提交（由「消耗品审批」通过后从持有量结清，不回库） */
export class BorrowWriteOffCreateDto extends IdempotentDto {
  @ApiProperty({ description: '核销明细行（同一借还记录整单只能一次）', type: [BorrowWriteOffItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BorrowWriteOffItemDto)
  items!: BorrowWriteOffItemDto[];
}

/** 我的借还查询（本人档：本人借出、未结清、逾期、归还/核销申请） */
export class MyBorrowQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '结清状态', required: false, enum: ['OPEN', 'SETTLED'] })
  @IsOptional()
  @IsIn(['OPEN', 'SETTLED'])
  settlementStatus?: 'OPEN' | 'SETTLED';

  @ApiProperty({ description: '是否仅逾期', required: false })
  @IsOptional()
  @Type(() => Boolean)
  overdueOnly?: boolean;
}

/** 借还历史查询（「借还历史记录」部门/公司档：按记录类型/借用人/代交人/受领人/部门/结清状态/逾期查询） */
export class BorrowHistoryQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '记录类型', required: false, enum: ['PERSONAL', 'AGENT'] })
  @IsOptional()
  @IsIn(['PERSONAL', 'AGENT'])
  recordType?: 'PERSONAL' | 'AGENT';

  @ApiProperty({ description: '借用人 / 代交人 id（PERSONAL 借用人；AGENT 发起人）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;

  @ApiProperty({ description: '受领人 id（仅 AGENT 记录筛选）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  recipientId?: number;

  @ApiProperty({ description: '部门 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @ApiProperty({ description: '结清状态', required: false, enum: ['OPEN', 'SETTLED'] })
  @IsOptional()
  @IsIn(['OPEN', 'SETTLED'])
  settlementStatus?: 'OPEN' | 'SETTLED';

  @ApiProperty({ description: '是否仅逾期', required: false })
  @IsOptional()
  @Type(() => Boolean)
  overdueOnly?: boolean;
}
