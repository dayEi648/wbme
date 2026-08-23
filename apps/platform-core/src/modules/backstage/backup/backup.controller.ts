import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Inject, Post, Query, Res, UseGuards } from '@nestjs/common';
import { DATA_BACKUP_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser, RateLimit, RateLimitGuard, RequestTimeout } from '@wbme/server';
import type { Response } from 'express';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import {
  ImmediateBackupDto,
  ListBackupsDto,
  ListRestoresDto,
  RestoreConfirmDto,
  RestorePrecheckDto,
} from './backup.dto';
import { BackupService, EMERGENCY_BACKUP_WAIT_MS } from './backup.service';
import { RecoverySessionClient } from './recovery-session.client';

/** 恢复确认路由超时：紧急备份等待上限 300s + 30s 处理/响应缓冲（全局默认 30s 会截断长任务） */
const RESTORE_CONFIRM_TIMEOUT_MS = EMERGENCY_BACKUP_WAIT_MS + 30_000;

/**
 * 数据备份与恢复管理 API（backstage PRD §10）。
 */
@ApiTags('数据备份')
@Controller()
@UseGuards(FunctionPermissionGuard)
@RequireFunction(DATA_BACKUP_FUNCTION_CODE)
export class BackupController {
  constructor(
    private readonly backup: BackupService,
    @Inject(RecoverySessionClient) private readonly recoverySession: RecoverySessionClient,
  ) {}

  @Get('backups')
  listBackups(@Query() query: ListBackupsDto): Promise<unknown> {
    return this.backup.listBackups(query);
  }

  @Post('backups/immediate')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'backup-immediate', keyType: 'user', limit: 5, windowSeconds: 300 })
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
  @RequestTimeout(RESTORE_CONFIRM_TIMEOUT_MS)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'restore-confirm', keyType: 'user', limit: 5, windowSeconds: 300 })
  confirmRestore(@CurrentUser() operatorId: number, @Body() dto: RestoreConfirmDto): Promise<unknown> {
    return this.backup.confirmRestore(operatorId, dto);
  }

  /**
   * 签发恢复控制会话（超管；恢复失败后人工介入通道，backstage PRD §10）。
   * Cookie 透传设置（path=/recovery；维护状态下浏览器经 Nginx /recovery/ 反代
   * 到恢复执行器携带本 Cookie 操作，非维护状态 /recovery/ 一律 404）。
   */
  @Post('restores/session')
  async issueRecoverySession(
    @CurrentUser() operatorId: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.backup.assertSuperAdmin(operatorId);
    const { cookieName, token } = await this.recoverySession.issueSession(operatorId);
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/recovery',
      maxAge: 60 * 60 * 1000,
    });
    return { ok: true };
  }
}
