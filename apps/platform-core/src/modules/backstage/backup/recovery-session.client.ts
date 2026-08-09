import { Injectable } from '@nestjs/common';
import { BusinessException, integrationErrors } from '@wbme/contracts';
import { InternalHttpClient, InternalRequestError } from '@wbme/server';

/** 恢复执行器内部地址（开发默认本地回环；生产 compose 私网 http://recovery-executor:3010） */
const RECOVERY_EXECUTOR_INTERNAL_BASE_URL =
  process.env.RECOVERY_EXECUTOR_INTERNAL_BASE_URL ?? 'http://localhost:3010';

/** 恢复控制 Cookie 名（与执行器 RECOVERY_COOKIE_NAME 一致） */
export const RECOVERY_SESSION_COOKIE_NAME = 'wbme_recovery_session';

/**
 * 恢复控制会话签发客户端（backstage PRD §10 人工介入通道，T4-8 接线）：
 * 超管登录验证后调用执行器 `POST /recovery/session`（内部令牌 + platform-core 白名单），
 * 取回控制 Cookie 值由调用方透传设置（path=/recovery；生产 Nginx 同域代理 /recovery/* → 执行器）。
 */
@Injectable()
export class RecoverySessionClient {
  private readonly client: InternalHttpClient | null;

  /**
   * 从部署环境装配内部客户端（INTERNAL_SERVICE_TOKEN 缺失/过短 → null，签发时归为依赖错误）。
   */
  constructor() {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? '';
    this.client = token
      ? new InternalHttpClient({ baseUrl: RECOVERY_EXECUTOR_INTERNAL_BASE_URL, token, caller: 'platform-core' })
      : null;
  }

  /**
   * 签发恢复控制会话（userId 为已登录超管）。
   *
   * @param userId 超管用户 id
   * @returns 控制 Cookie 名与值
   * @throws SERVICE_UNAVAILABLE 执行器不可用或未返回会话 Cookie（DEPENDENCY）
   */
  async issueSession(userId: number): Promise<{ cookieName: string; token: string }> {
    if (!this.client) {
      throw new BusinessException(integrationErrors.SERVICE_UNAVAILABLE, {
        reason: '内部令牌未配置，无法签发恢复控制会话',
      });
    }
    let response: Response;
    try {
      response = await this.client.write('/recovery/session', { method: 'POST', body: { userId } });
    } catch (error) {
      if (error instanceof InternalRequestError) {
        throw new BusinessException(integrationErrors.SERVICE_UNAVAILABLE, {
          reason: '恢复执行器不可用，无法签发控制会话',
        });
      }
      throw error;
    }
    const setCookie = response.headers.get('set-cookie') ?? '';
    const match = new RegExp(`${RECOVERY_SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
    if (!match?.[1]) {
      throw new BusinessException(integrationErrors.SERVICE_UNAVAILABLE, {
        reason: '恢复执行器未返回控制会话 Cookie',
      });
    }
    return { cookieName: RECOVERY_SESSION_COOKIE_NAME, token: match[1] };
  }
}
