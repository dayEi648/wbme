import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
} from 'class-validator';
import { BATCH_LIMIT, IdempotentDto, PaginationQueryDto } from './base.dto';

/** 自然日格式：YYYY-MM-DD（主 PRD §9.10） */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 月份格式：YYYY-MM */
export const MONTH_PATTERN = /^\d{4}-\d{2}$/;

/**
 * 加班 DTO（hr PRD §3）。
 * 一个批次共用同一日期、时间段与事由；起止时间按"当日第 N 分钟"表达，`24:00`=1440。
 */

/** 提交加班批次（全有或全无；提交人=当前用户，可含代提对象） */
export class OvertimeSubmitDto extends IdempotentDto {
  @IsString()
  @Matches(DATE_PATTERN)
  overtimeDate!: string;

  /** 结束分钟必须晚于开始分钟（`24:00`=1440 仅作当日结束边界） */
  @Validate(
    (dto: OvertimeSubmitDto) => dto.startMinute < dto.endMinute,
    { message: '结束时间必须晚于开始时间' },
  )
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1439)
  startMinute!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  endMinute!: number;

  @IsString()
  @MaxLength(500)
  reason!: string;

  /** 加班员工名单（含本人；"加班申请"本人档时服务端强制为 [本人]） */
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  userIds!: number[];
}

/** 个人加班记录查询（hr PRD §3 个人视图：本人已批准记录） */
export class OvertimeMineQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Matches(MONTH_PATTERN)
  month?: string;
}

/** 个人月度汇总查询 */
export class OvertimeSummaryQueryDto {
  @IsOptional()
  @IsString()
  @Matches(MONTH_PATTERN)
  month?: string;
}

/** 管理视图查询（加班历史记录功能，hr PRD §3：员工列表 + 月度统计 + 下钻） */
export class OvertimeManageQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Matches(MONTH_PATTERN)
  month?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;
}

/** 管理月度汇总查询 */
export class OvertimeManageSummaryDto {
  @IsOptional()
  @IsString()
  @Matches(MONTH_PATTERN)
  month?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;
}
