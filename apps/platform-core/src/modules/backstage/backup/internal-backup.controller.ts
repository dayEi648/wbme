import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AllowedCallers, InternalAuthGuard, Public } from '@wbme/server';
import type { ImmediateBackupDto } from './backup.dto';
import { BackupService } from './backup.service';

/**
 * 数据备份内部接口（主 PRD §9.4）。
 *
 * 仅供 migration-runner 在部署迁移前触发立即备份；不暴露公网，不走用户会话与权限目录。
 * 保留与公开端点相同的备份互斥锁与「存在未完成恢复清单则拒绝」逻辑。
 */
@UseGuards(InternalAuthGuard)
@Controller('internal/v1/backups')
export class InternalBackupController {
  constructor(private readonly backup: BackupService) {}

  /** migration-runner 调用：迁移前立即备份 */
  @Public()
  @Post('immediate')
  @AllowedCallers('migration-runner')
  async immediateBackup(@Body() dto: ImmediateBackupDto): Promise<{ backupId: number; taskUuid: string }> {
    return this.backup.triggerImmediateBackupInternal('migration-runner', dto);
  }

  /** migration-runner 轮询：查询指定备份状态 */
  @Public()
  @Get('immediate/status/:backupId')
  @AllowedCallers('migration-runner')
  async getBackupStatus(@Param('backupId', ParseIntPipe) backupId: number): Promise<{ status: string }> {
    const backup = await this.backup.findBackupById(backupId);
    return { status: backup?.status ?? 'NOT_FOUND' };
  }
}
