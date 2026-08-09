import { Body, Controller, Get, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RestoreDeliveryTaskRef } from '@wbme/tasks';
import { InternalTokenGuard } from './internal-token.guard';
import { RECOVERY_COOKIE_NAME, RecoveryExecutorService } from './recovery-executor.service';

/**
 * 恢复执行器内部控制路由（不走 /api/v1 会话；内部投递走令牌、控制操作走 Cookie 会话）。
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

  /** Worker 内部投递 RESTORE_DELIVERY（内部令牌 + 调用方白名单） */
  @Post('delivery')
  @UseGuards(new InternalTokenGuard(['worker']))
  async delivery(@Body() ref: RestoreDeliveryTaskRef): Promise<{ accepted: true }> {
    await this.recovery.acceptDelivery(ref);
    return { accepted: true };
  }

  /** platform-core 内部签发恢复控制会话 Cookie（超管已登录验证后调用） */
  @Post('session')
  @UseGuards(new InternalTokenGuard(['platform-core']))
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
