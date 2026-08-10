import { Injectable } from '@nestjs/common';
import { BusinessException, integrationErrors } from '@wbme/contracts';
import { InternalHttpClient, InternalRequestError } from '@wbme/server';

/**
 * 恢复执行器内部地址（开发默认本地回环 3090，与执行器默认端口一致；生产 compose 私网 http://recovery-executor:3090）。
 * 恢复执行器内部控制路由挂在 `/recovery/*` 下（无 `/internal/v1` 前缀），
 * 因此 base URL 不得带 internal 后缀，否则 InternalHttpClient 直拼 `${baseUrl}${path}`
 * 会请求到不存在的 `/internal/v1/recovery/session` → 404（M29）。
 */
const RECOVERY_EXECUTOR_INTERNAL_BASE_URL =
  process.env.RECOVERY_EXECUTOR_INTERNAL_BASE_URL ?? 'http://localhost:3090';

/** 恢复控制 Cookie 名（与执行器 RECOVERY_COOKIE_NAME 一致） */
export const RECOVERY_SESSION_COOKIE_NAME = 'wbme_recovery_session';

/**
 * 恢复控制会话签发客户端（backstage PRD §10 人工介入通道）：
 * 超管登录验证后调用执行器 `POST /recovery/session`（内部令牌 + platform-core 白名单），
 * 取回控制 Cookie 值由调用方透传设置（path=/recovery）。
 * 注意：nginx.conf 未配置 /recovery 反代（浏览器端恢复控制通道不可达），
 * 恢复演练经 docker exec 直连执行器端口进行（restore-drill.md）。
 */
@Injectable()
export class RecoverySessionClient {
  private readonly client: InternalHttpClient | null;

  /**
   * 从部署环境装配内部客户端（INTERNAL_SERVICE_TOKEN 缺失/过短 → null，签发时归为依赖错误）。
   */
  constructor() {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? '';
    // 防回归断言（M29）：base URL 误带 /internal/v1 时所有签发请求必然 404，装配期即暴露
    if (RECOVERY_EXECUTOR_INTERNAL_BASE_URL.includes('/internal')) {
      throw new Error(
        `RECOVERY_EXECUTOR_INTERNAL_BASE_URL 不得包含 /internal 前缀（恢复执行器路由为 /recovery/*）：${RECOVERY_EXECUTOR_INTERNAL_BASE_URL}`,
      );
    }
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
