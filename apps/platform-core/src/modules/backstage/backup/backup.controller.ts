import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { DATA_BACKUP_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import {
  ImmediateBackupDto,
  ListBackupsDto,
  ListRestoresDto,
  RestoreConfirmDto,
  RestorePrecheckDto,
} from './backup.dto';
import { BackupService } from './backup.service';

/**
 * 数据备份与恢复管理 API（backstage PRD §10）。
 */
@ApiTags('数据备份')
@Controller()
@UseGuards(FunctionPermissionGuard)
@RequireFunction(DATA_BACKUP_FUNCTION_CODE)
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get('backups')
  listBackups(@Query() query: ListBackupsDto): Promise<unknown> {
    return this.backup.listBackups(query);
  }

  @Post('backups/immediate')
  immediateBackup(@CurrentUser() operatorId: number, @Body() dto: ImmediateBackupDto): Promise<unknown> {
    return this.backup.triggerImmediateBackup(operatorId, dto);
  }

  @Get('restores')
  listRestores(@Query() query: ListRestoresDto): Promise<unknown> {
    return this.backup.listRestores(query);
  }

  @Post('restores/precheck')
  precheckRestore(@CurrentUser() operatorId: number, @Body() dto: RestorePrecheckDto): Promise<unknown> {
    return this.backup.precheckRestore(operatorId, dto.backupId);
  }

  @Post('restores/confirm')
  confirmRestore(@CurrentUser() operatorId: number, @Body() dto: RestoreConfirmDto): Promise<unknown> {
    return this.backup.confirmRestore(operatorId, dto);
  }
}
