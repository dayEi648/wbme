import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
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

  /**
   * 紧急备份失败时是否仍继续恢复（人工明确确认风险后置 true；
   * backstage PRD §10：不得伪装为已有回退副本）。
   */
  @IsOptional()
  @IsBoolean()
  proceedWithoutEmergency?: boolean;
}

/** 备份列表 */
export class ListBackupsDto extends PaginationQueryDto {}

/** 恢复列表 */
export class ListRestoresDto extends PaginationQueryDto {}
