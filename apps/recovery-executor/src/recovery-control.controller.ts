import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RestoreDeliveryTaskRef } from '@wbme/tasks';
import { RECOVERY_COOKIE_NAME, RecoveryExecutorService } from './recovery-executor.service';

/**
 * 恢复执行器内部控制路由（不走 /api/v1 会话；Cookie 鉴权）。
 */
@Controller('recovery')
export class RecoveryControlController {
  constructor(private readonly recovery: RecoveryExecutorService) {}

  @Get('health')
  health(): { ok: true } {
    return this.recovery.health();
  }

  @Get('status')
  async status(@Req() req: Request): Promise<unknown> {
    this.assertRecoverySession(req);
    return this.recovery.getStatus();
  }

  @Post('retry')
  async retry(@Req() req: Request): Promise<{ ok: true }> {
    this.assertRecoverySession(req);
    await this.recovery.retry();
    return { ok: true };
  }

  /** Worker 内部投递 RESTORE_DELIVERY（MVP：无鉴权，仅限内网） */
  @Post('delivery')
  async delivery(@Body() ref: RestoreDeliveryTaskRef): Promise<{ accepted: true }> {
    await this.recovery.acceptDelivery(ref);
    return { accepted: true };
  }

  @Post('session')
  issueSession(@Body() body: { userId: number }, @Res({ passthrough: true }) res: Response): { ok: true } {
    const secret = process.env.RECOVERY_SESSION_SECRET?.trim();
    if (!secret) {
      throw new UnauthorizedException('RECOVERY_SESSION_SECRET 未配置');
    }
    const token = this.recovery.issueRecoverySessionToken(body.userId, secret);
    res.cookie(RECOVERY_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/recovery',
      maxAge: 60 * 60 * 1000,
    });
    return { ok: true };
  }

  private assertRecoverySession(req: Request): void {
    const secret = process.env.RECOVERY_SESSION_SECRET?.trim();
    if (!secret) {
      throw new UnauthorizedException('RECOVERY_SESSION_SECRET 未配置');
    }
    const token = req.cookies?.[RECOVERY_COOKIE_NAME] as string | undefined;
    if (!token || !this.recovery.verifyRecoverySessionToken(token, secret)) {
      throw new UnauthorizedException('恢复会话无效');
    }
  }
}
