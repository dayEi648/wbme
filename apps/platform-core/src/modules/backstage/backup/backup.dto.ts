import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { IdempotentDto, PaginationQueryDto } from '@wbme/contracts';

/** 立即备份 */
export class ImmediateBackupDto extends IdempotentDto {}

/** 恢复预检 */
export class RestorePrecheckDto {
  @IsInt()
  backupId!: number;
}

/** 恢复确认 */
export class RestoreConfirmDto extends IdempotentDto {
  @IsInt()
  backupId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** 备份列表 */
export class ListBackupsDto extends PaginationQueryDto {}

/** 恢复列表 */
export class ListRestoresDto extends PaginationQueryDto {}
