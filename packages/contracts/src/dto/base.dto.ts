import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * DTO 基类与通用片段（主 PRD §9.5）。
 *
 * 全局校验管道统一启用 DTO 转换、白名单与非白名单字段拒绝；
 * 未声明字段直接拒绝，字符串长度、数值范围、批量数量必须有明确约束。
 *
 * 说明：共享契约包 DTO 不使用 Swagger CLI plugin（plugin 只处理各应用自身源码），
 * 全部属性显式标注 @ApiProperty 以保证 OpenAPI 文档与校验契约一致。
 */

/** 幂等写接口的公共字段（主 PRD §9.5：重要写接口支持幂等键） */
export class IdempotentDto {
  /** 客户端为一次用户意图生成的幂等键；网络重试时保持不变 */
  @ApiProperty({
    description: '客户端为一次用户意图生成的幂等键；网络重试时保持不变',
    required: false,
    maxLength: 128,
  })
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
  @ApiProperty({
    description: '页码（从 1 开始）',
    required: false,
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiProperty({
    description: '每页条数（服务端接受 10/20/50/100）',
    required: false,
    default: 20,
    minimum: 10,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(100)
  pageSize: number = 20;
}
