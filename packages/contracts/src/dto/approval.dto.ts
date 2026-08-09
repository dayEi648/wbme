import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { IdempotentDto, PaginationQueryDto } from './base.dto';

/** 审批列表状态筛选：待处理 / 已处理 / 或具体状态 */
export type ApprovalListStatusFilter =
  | 'PENDING'
  | 'PROCESSED'
  | 'DRAFT'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

/**
 * 审批中心列表查询（主 PRD §3.2 / T5-2）。
 * 各部署单元同语义；requestType 取值由模块声明。
 */
export class ApprovalListQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '申请类型（取值由各模块声明）',
    required: false,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestType?: string;

  /** PENDING=待处理；PROCESSED=已处理（批准/驳回/取消）；或具体状态 */
  @ApiProperty({
    description: 'PENDING=待处理；PROCESSED=已处理（批准/驳回/取消）；或具体状态',
    required: false,
    enum: ['PENDING', 'PROCESSED', 'DRAFT', 'APPROVED', 'REJECTED', 'CANCELLED'],
  })
  @IsOptional()
  @IsIn(['PENDING', 'PROCESSED', 'DRAFT', 'APPROVED', 'REJECTED', 'CANCELLED'])
  status?: ApprovalListStatusFilter;

  @ApiProperty({
    description: '关键字（单号/申请人等模糊匹配）',
    required: false,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @ApiProperty({
    description: '申请人姓名',
    required: false,
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  applicantName?: string;

  @ApiProperty({
    description: '处理人姓名',
    required: false,
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processorName?: string;
}

/** 审批处理（批准/驳回） */
export class ProcessApprovalDto extends IdempotentDto {
  @ApiProperty({
    description: '处理动作：APPROVE=批准 / REJECT=驳回',
    enum: ['APPROVE', 'REJECT'],
  })
  @IsIn(['APPROVE', 'REJECT'])
  action!: 'APPROVE' | 'REJECT';

  @ApiProperty({
    description: '处理意见',
    required: false,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  opinion?: string;
}

/** 申请人/代交人取消待审批 */
export class CancelApprovalDto extends IdempotentDto {}

/** 内部 pending-count 查询：按用户 id 统计可见待办（门户角标聚合） */
export class InternalPendingCountQueryDto {
  @ApiProperty({
    description: '用户 id',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;
}
