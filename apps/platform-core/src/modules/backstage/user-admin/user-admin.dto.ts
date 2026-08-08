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
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BATCH_LIMIT, IdempotentDto, PaginationQueryDto } from '@wbme/contracts';

/**
 * 用户管理接口 DTO（backstage PRD §3、主 PRD §9.5）。
 * 全部写接口支持幂等键；批量目标上限 100 为固定资源上限。
 */

/** 创建用户：姓名/手机号/性别（待激活基础账号，无密码未绑钉钉） */
export class CreateUserDto extends IdempotentDto {
  /** 姓名 */
  @IsString()
  @MaxLength(50)
  name!: string;

  /** 手机号（入库前规范化为 +国家码 格式；在待激活与正常账号间唯一） */
  @IsString()
  @MaxLength(32)
  phone!: string;

  /** 性别 */
  @IsIn(['MALE', 'FEMALE'])
  gender!: 'MALE' | 'FEMALE';
}

/** 用户列表查询：状态筛选 + 姓名/手机号模糊 + 分页 */
export class ListUsersDto extends PaginationQueryDto {
  /** 状态筛选：PENDING_ACTIVATION 待激活 / ACTIVE 正常 / DEACTIVATED 已注销；缺省 = 未注销全部 */
  @IsOptional()
  @IsIn(['PENDING_ACTIVATION', 'ACTIVE', 'DEACTIVATED'])
  status?: 'PENDING_ACTIVATION' | 'ACTIVE' | 'DEACTIVATED';

  /** 检索词：姓名模糊匹配（不区分大小写）；含数字时同时匹配手机号片段 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;
}

/** 编辑用户基本资料（仅姓名和性别；手机号只读，不提供修改入口） */
export class UpdateUserDto extends IdempotentDto {
  /** 姓名 */
  @IsString()
  @MaxLength(50)
  name!: string;

  /** 性别 */
  @IsIn(['MALE', 'FEMALE'])
  gender!: 'MALE' | 'FEMALE';
}

/** 批量注销 */
export class BatchDeactivateDto extends IdempotentDto {
  /** 目标用户标识（最多 100 个互不重复，主 PRD §9.5 固定上限） */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  userIds!: number[];
}

/** 恢复预览：进入恢复流程即实际调用 hr 内部接口（不可用则整流程不可用） */
export class RestorePreviewDto {
  /** 目标用户标识（已注销账号；最多 100 个互不重复） */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  userIds!: number[];
}

/** 恢复确认目标（携带预览时取得的账号生命周期版本） */
export class RestoreTargetDto {
  /** 目标用户 id */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;

  /** 账号生命周期版本（乐观并发校验；预览响应原样回传） */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lifecycleVersion!: number;
}

/** 恢复确认：稳定恢复请求 ID + 各账号生命周期版本（两阶段安全顺序，backstage PRD §3） */
export class RestoreConfirmDto extends IdempotentDto {
  /** 稳定恢复请求 ID（预览响应返回；同 ID 重试幂等） */
  @IsUUID()
  restoreRequestId!: string;

  /** 恢复目标（含生命周期版本；最多 100 个） */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique((item: RestoreTargetDto) => item.userId)
  @ValidateNested({ each: true })
  @Type(() => RestoreTargetDto)
  targets!: RestoreTargetDto[];
}
