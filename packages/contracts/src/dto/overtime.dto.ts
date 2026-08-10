import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { BATCH_LIMIT, IdempotentDto, PaginationQueryDto } from './base.dto';

/** 自然日格式：YYYY-MM-DD（主 PRD §9.10） */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 月份格式：YYYY-MM（L14：月份限定 01–12，拒绝 `2026-13` 静默进位） */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 加班起止分钟交叉字段校验；必须使用约束类以访问完整 DTO，而非把函数误传给 @Validate。 */
@ValidatorConstraint({ name: 'overtimeTimeRange', async: false })
class OvertimeTimeRangeConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, arguments_: ValidationArguments): boolean {
    const dto = arguments_.object as Partial<OvertimeSubmitDto>;
    const { startMinute, endMinute } = dto;
    return Number.isInteger(startMinute) && Number.isInteger(endMinute) && startMinute !== undefined && endMinute !== undefined && startMinute < endMinute;
  }

  defaultMessage(): string {
    return '结束时间必须晚于开始时间';
  }
}

/**
 * 加班 DTO（hr PRD §3）。
 * 一个批次共用同一日期、时间段与事由；起止时间按"当日第 N 分钟"表达，`24:00`=1440。
 */

/** 提交加班批次（全有或全无；提交人=当前用户，可含代提对象） */
export class OvertimeSubmitDto extends IdempotentDto {
  @ApiProperty({
    description: '加班日期（YYYY-MM-DD）',
    example: '2026-08-09',
  })
  @IsString()
  @Matches(DATE_PATTERN)
  overtimeDate!: string;

  /** 结束分钟必须晚于开始分钟（`24:00`=1440 仅作当日结束边界） */
  @ApiProperty({
    description: '开始分钟（当日第 N 分钟，0-1439；必须早于结束分钟）',
    minimum: 0,
    maximum: 1439,
  })
  @Validate(OvertimeTimeRangeConstraint)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1439)
  startMinute!: number;

  @ApiProperty({
    description: '结束分钟（当日第 N 分钟，1-1440；`24:00`=1440 仅作当日结束边界）',
    minimum: 1,
    maximum: 1440,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  endMinute!: number;

  @ApiProperty({
    description: '加班事由',
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  reason!: string;

  /** 加班员工名单（含本人；"加班申请"本人档时服务端强制为 [本人]） */
  @ApiProperty({
    description: '加班员工名单（含本人；"加班申请"本人档时服务端强制为 [本人]）',
    type: 'array',
    items: { type: 'number', minimum: 1 },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  userIds!: number[];
}

/** 日期类型查询（hr PRD §3：提交前展示日期类型/时长/补交提示的前置契约） */
export class DateTypeQueryDto {
  @ApiProperty({
    description: '查询日期（YYYY-MM-DD）',
    example: '2026-08-09',
  })
  @IsString()
  @Matches(DATE_PATTERN)
  date!: string;
}

/** 个人加班记录查询（hr PRD §3 个人视图：本人已批准记录） */
export class OvertimeMineQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '月份（YYYY-MM）',
    required: false,
    example: '2026-08',
  })
  @IsOptional()
  @IsString()
  @Matches(MONTH_PATTERN)
  month?: string;
}

/** 个人月度汇总查询 */
export class OvertimeSummaryQueryDto {
  @ApiProperty({
    description: '月份（YYYY-MM；空 = 当月）',
    required: false,
    example: '2026-08',
  })
  @IsOptional()
  @IsString()
  @Matches(MONTH_PATTERN)
  month?: string;
}

/** 管理视图查询（加班历史记录功能，hr PRD §3：员工列表 + 月度统计 + 下钻） */
export class OvertimeManageQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '月份（YYYY-MM）',
    required: false,
    example: '2026-08',
  })
  @IsOptional()
  @IsString()
  @Matches(MONTH_PATTERN)
  month?: string;

  @ApiProperty({
    description: '关键字（姓名等模糊匹配）',
    required: false,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @ApiProperty({
    description: '按部门过滤',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;
}

/** 管理月度汇总查询 */
export class OvertimeManageSummaryDto {
  @ApiProperty({
    description: '月份（YYYY-MM；空 = 当月）',
    required: false,
    example: '2026-08',
  })
  @IsOptional()
  @IsString()
  @Matches(MONTH_PATTERN)
  month?: string;

  @ApiProperty({
    description: '按部门过滤',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;
}
