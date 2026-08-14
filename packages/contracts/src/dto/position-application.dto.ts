import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { IdempotentDto, PaginationQueryDto } from './base.dto';

/**
 * 岗位申请 DTO（hr PRD §5 / base PRD §6）。
 * 每张申请固定一个目标部门 + 一个目标岗位；仅无部门/单部门员工可自助申请。
 */

/** 个人中心提交岗位变更申请（base PRD §6 P4，前端请求） */
export class PositionApplicationSubmitDto extends IdempotentDto {
  @ApiProperty({
    description: '目标部门 id',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetDepartmentId!: number;

  @ApiProperty({
    description: '目标岗位 id',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetPositionId!: number;
}

/** 内部提交岗位申请（platform-core 个人中心代传；携带实际操作者 userId） */
export class InternalPositionApplicationSubmitDto extends IdempotentDto {
  @ApiProperty({
    description: '实际操作者用户 id（platform-core 代传）',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;

  @ApiProperty({
    description: '目标部门 id',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetDepartmentId!: number;

  @ApiProperty({
    description: '目标岗位 id',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetPositionId!: number;
}

/** 内部查询我的岗位申请记录（P5） */
export class InternalPositionApplicationQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '用户 id',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;
}
