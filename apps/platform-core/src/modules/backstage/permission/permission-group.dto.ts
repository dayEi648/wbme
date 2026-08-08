import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { BATCH_LIMIT, IdempotentDto } from '@wbme/contracts';
import { GrantItemDto } from './permission.dto';

/**
 * 权限组维护 DTO（backstage PRD §4、主 PRD §3.1；S-6/S-7）。
 * 权限组是命名的授权预设（可跨系统），授予员工时展开为员工功能授权快照。
 */

/** 创建权限组：命名 + 描述 + 明细（功能编码 + 数据范围） */
export class CreatePermissionGroupDto extends IdempotentDto {
  /** 组名（唯一；S-6 唯一约束覆盖已软删除组） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name!: string;

  /** 组描述 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** 组内功能授权明细（可空数组 = 空组；同一功能编码+数据范围不可重复） */
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => GrantItemDto)
  items!: GrantItemDto[];
}

/** 编辑权限组：名称/描述更新 + 明细事务内全量替换（S-7） */
export class UpdatePermissionGroupDto extends IdempotentDto {
  /** 组名（唯一；S-6 唯一约束覆盖已软删除组） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name!: string;

  /** 组描述 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** 组内功能授权明细（全量替换语义） */
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => GrantItemDto)
  items!: GrantItemDto[];
}

/** 批量删除权限组（软删除；全有或全无，主 PRD §2.6） */
export class BatchDeleteGroupsDto extends IdempotentDto {
  /** 目标组标识（最多 100 个互不重复，主 PRD §9.5 固定上限） */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  groupIds!: number[];
}
