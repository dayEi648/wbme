import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { BATCH_LIMIT } from './base.dto';

/**
 * hr 生命周期内部接口 DTO（backstage PRD §3 / hr PRD §5）。
 * 调用方：platform-core（restore-preview / restore-apply）、worker（cancel-position-applications）。
 */

/** 单个恢复目标（platform-core 用户批量恢复的 hr 侧身份） */
export class HrRestoreTargetDto {
  @ApiProperty({
    description: '用户 id',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;

  /** 注销时间（RFC 3339/ISO 8601）：用于取消"注销前提交且仍待审批"的岗位申请 */
  @ApiProperty({
    description: '注销时间（RFC 3339/ISO 8601）：用于取消"注销前提交且仍待审批"的岗位申请',
  })
  @IsDateString()
  deactivatedAt!: string;

  /** 账号生命周期版本：平台侧注销事务的版本，hr 侧比对防目标漂移 */
  @ApiProperty({
    description: '账号生命周期版本：平台侧注销事务的版本，hr 侧比对防目标漂移',
    minimum: 0,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lifecycleVersion!: number;
}

/** 恢复预览请求（只读兼容性检查，不写数据） */
export class HrRestorePreviewDto {
  @ApiProperty({
    description: '恢复请求 id（uuid）',
  })
  @IsUUID()
  restoreRequestId!: string;

  @ApiProperty({
    description: '恢复目标列表',
    type: 'array',
    items: { $ref: 'HrRestoreTargetDto' },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique((t: HrRestoreTargetDto) => t.userId)
  @ValidateNested({ each: true })
  @Type(() => HrRestoreTargetDto)
  targets!: HrRestoreTargetDto[];
}

/** 恢复应用请求（单事务整批应用；restoreRequestId 为幂等键） */
export class HrRestoreApplyDto extends HrRestorePreviewDto {}

/** worker 调用：幂等取消"注销前已提交且仍待审批"的岗位申请 */
export class HrCancelPositionApplicationsDto {
  @ApiProperty({
    description: '用户 id',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;

  @ApiProperty({
    description: '注销时间（RFC 3339/ISO 8601）',
  })
  @IsDateString()
  deactivatedAt!: string;
}
