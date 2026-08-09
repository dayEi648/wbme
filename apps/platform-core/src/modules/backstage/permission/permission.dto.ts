import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BATCH_LIMIT, IdempotentDto, PaginationQueryDto, type DataScope } from '@wbme/contracts';

/**
 * 权限管理接口 DTO（backstage PRD §4、主 PRD §3.1/§9.5）。
 *
 * 全局校验管道启用白名单与非白名单字段拒绝；批量目标上限 100 为固定资源上限。
 */

/** 员工检索查询（姓名/手机号模糊 + 分页） */
export class SearchEmployeesDto extends PaginationQueryDto {
  /** 检索词：姓名模糊匹配（不区分大小写）；含数字时同时匹配手机号片段 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;
}

/** 一项功能授权（功能编码 + 数据范围） */
export class GrantItemDto {
  /** 稳定功能编码（必须仍注册于权限目录） */
  @IsString()
  @MaxLength(64)
  functionCode!: string;

  /** 数据范围档位（必须在功能声明的可选档位内） */
  @IsIn(['SELF', 'DEPARTMENT', 'COMPANY'])
  dataScope!: DataScope;
}

/** 保存单人权限（修改权限）：一次性提交可管理范围内的完整功能状态 + 授权版本 */
export class SaveEmployeeGrantsDto extends IdempotentDto {
  /** 打开页面时取得的目标员工授权版本（乐观并发控制，事务内条件更新） */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  permissionVersion!: number;

  /** 目标员工的完整功能授权状态（操作人可管理范围内）；空数组 = 清空可管理范围授权 */
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => GrantItemDto)
  grants!: GrantItemDto[];
}

/** 批量授权（增量）：为所选员工追加功能授权，不改动其已有授权 */
export class BatchGrantDto extends IdempotentDto {
  /** 目标员工标识（最多 100 个互不重复，主 PRD §9.5 固定上限） */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  userIds!: number[];

  /** 逐项追加的功能授权（含数据范围）；与 groupIds 至少一项非空（服务层校验） */
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => GrantItemDto)
  grants!: GrantItemDto[];

  /** 权限组展开：组内失效项跳过不计入授权，展开为员工授权快照，不产生组关联 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  groupIds?: number[];
}

/** 批量撤销：撤销所选员工在操作人可管理范围内的全部功能授权 */
export class BatchRevokeDto extends IdempotentDto {
  /** 目标员工标识（最多 100 个互不重复，主 PRD §9.5 固定上限） */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  userIds!: number[];
}
