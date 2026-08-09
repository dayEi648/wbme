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
  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestType?: string;

  /** PENDING=待处理；PROCESSED=已处理（批准/驳回/取消）；或具体状态 */
  @IsOptional()
  @IsIn(['PENDING', 'PROCESSED', 'DRAFT', 'APPROVED', 'REJECTED', 'CANCELLED'])
  status?: ApprovalListStatusFilter;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  applicantName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  processorName?: string;
}

/** 审批处理（批准/驳回） */
export class ProcessApprovalDto extends IdempotentDto {
  @IsIn(['APPROVE', 'REJECT'])
  action!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  opinion?: string;
}

/** 申请人/代交人取消待审批 */
export class CancelApprovalDto extends IdempotentDto {}

/** 内部 pending-count 查询：按用户 id 统计可见待办（门户角标聚合） */
export class InternalPendingCountQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;
}
