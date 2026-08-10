import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { BATCH_LIMIT, IdempotentDto, PaginationQueryDto } from '@wbme/contracts';

/** 发布流程追加更新日志（内部接口；releaseId 幂等，重复发布不重复记录） */
export class AppendReleaseLogDto {
  /** 唯一发布标识（通常为 tag） */
  @IsString()
  @MaxLength(100)
  releaseId!: string;

  /** 语义化版本号 */
  @IsString()
  @MaxLength(50)
  version!: string;

  /** 全平台部署 Git commit（40 位 SHA） */
  @IsString()
  @MaxLength(64)
  commitSha!: string;

  /** 本次变更说明（上次成功部署 commit 不含 → 本次含，Conventional Commits 标题剥离前缀） */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  subjects?: string[];
}

/** 创建/编辑公告 */
export class UpsertAnnouncementDto extends IdempotentDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  content?: string;
}

/** 批量删除公告 */
export class BatchDeleteAnnouncementsDto extends IdempotentDto {
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique({ message: '删除目标 id 不能重复' })
  @IsInt({ each: true })
  ids!: number[];
}

/** 发布公告 */
export class PublishAnnouncementDto extends IdempotentDto {}

/** 撤回公告 */
export class RevokeAnnouncementDto extends IdempotentDto {}

/** 更新日志列表查询 */
export class ListReleaseLogsDto extends PaginationQueryDto {}

/** 公告列表查询 */
export class ListAnnouncementsDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHING', 'REVOKED'])
  status?: 'DRAFT' | 'PUBLISHING' | 'REVOKED';
}
