import { Inject, Injectable } from '@nestjs/common';
import { maskPhone, normalizePhoneFromParts } from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';
import { SecurityLogService } from '../security-log/security-log.service';

/**
 * 手机号自动同步（base PRD §2）。
 *
 * 平台手机号始终跟随当前绑定的钉钉身份：每次钉钉授权（登录/注册/激活/换绑/重置）
 * 返回的手机号经规范化后与账号现有手机号比对，不一致时在当次流程事务中原子更新
 * 并写安全日志（记录脱敏前后值）；新号码已被其他"待激活/正常"账号占用时跳过本次
 * 同步并写 PHONE_SYNC_CONFLICT（扫码登录本身不受影响）。
 */

@Injectable()
export class PhoneSyncService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly securityLog: SecurityLogService,
  ) {}

  /**
   * 按钉钉返回的手机号同步账号（在调用方事务内执行；提供事务客户端）。
   * @param tx 调用方事务中的 Prisma 客户端
   * @returns 同步结果：updated=已更新；skipped_conflict=被占用跳过；no_change=无需更新
   */
  async syncFromDingtalk(
    tx: Pick<PrismaService['client'], 'user' | '$transaction'>,
    userId: number,
    stateCode: string,
    mobile: string,
    sourceIp?: string,
  ): Promise<{ outcome: 'updated' | 'skipped_conflict' | 'no_change' }> {
    const normalized = normalizePhoneFromParts(stateCode, mobile);
    if (!normalized) {
      // 钉钉未返回手机号：注册/激活由调用方拒绝；登录场景不更新
      return { outcome: 'no_change' };
    }
    const user = await tx.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!user || user.phone === normalized) {
      return { outcome: 'no_change' };
    }

    // 新号码唯一性：待激活 + 正常账号之间强制（注销账号为历史快照）
    const occupied = await tx.user.findFirst({
      where: {
        phone: normalized,
        id: { not: userId },
        deletedAt: null,
        status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] },
      },
      select: { id: true },
    });
    if (occupied) {
      await this.securityLog.record('PHONE_SYNC_CONFLICT', 'FAILURE', {
        targetUserId: userId,
        reason: '新号码被其他待激活/正常账号占用，跳过同步',
        context: { phoneMasked: maskPhone(normalized) },
        sourceIp,
      });
      return { outcome: 'skipped_conflict' };
    }

    await tx.user.update({ where: { id: userId }, data: { phone: normalized } });
    await this.securityLog.record('PHONE_SYNCED', 'SUCCESS', {
      targetUserId: userId,
      context: {
        fromMasked: maskPhone(user.phone),
        toMasked: maskPhone(normalized),
      },
      sourceIp,
    });
    return { outcome: 'updated' };
  }
}
