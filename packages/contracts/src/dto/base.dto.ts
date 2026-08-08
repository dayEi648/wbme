import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * DTO 基类与通用片段（主 PRD §9.5）。
 *
 * 全局校验管道统一启用 DTO 转换、白名单与非白名单字段拒绝；
 * 未声明字段直接拒绝，字符串长度、数值范围、批量数量必须有明确约束。
 */

/** 幂等写接口的公共字段（主 PRD §9.5：重要写接口支持幂等键） */
export class IdempotentDto {
  /** 客户端为一次用户意图生成的幂等键；网络重试时保持不变 */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

/** 批量操作公共约束：每次最多 100 个互不重复的目标标识（主 PRD §9.5 固定资源上限） */
export const BATCH_LIMIT = 100;

/** 全站分页参数：默认每页 20 条，可选 10/20/50/100 条，服务端最大接受 100（主 PRD §9.5） */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(100)
  pageSize: number = 20;
}
