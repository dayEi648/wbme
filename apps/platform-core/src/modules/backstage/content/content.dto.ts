import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { BATCH_LIMIT, IdempotentDto, PaginationQueryDto } from '@wbme/contracts';

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
