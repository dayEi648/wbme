import { Injectable, Logger } from '@nestjs/common';
import { InternalHttpClient, InternalRequestError } from '@wbme/server';

/** 各业务系统 pending-count 内部响应 */
interface PendingCountBody {
  total?: number;
}

/**
 * 门户待办角标聚合客户端（base PRD §5 / T5-2）。
 * 经内部 REST 拉取 hr/asset 可见待办数；依赖不可用时该系统贡献 0（不阻断门户）。
 */
@Injectable()
export class PendingBadgeClient {
  private readonly logger = new Logger(PendingBadgeClient.name);
  private readonly hr: InternalHttpClient | null;
  private readonly asset: InternalHttpClient | null;

  constructor(hr: InternalHttpClient | null, asset: InternalHttpClient | null) {
    this.hr = hr;
    this.asset = asset;
  }

  /** 从环境变量装配（令牌缺失 → null，调用贡献 0） */
  static fromEnv(): PendingBadgeClient {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? '';
    if (!token) {
      return new PendingBadgeClient(null, null);
    }
    const hrBase = process.env.HR_INTERNAL_BASE_URL ?? 'http://localhost:3003';
    const assetBase = process.env.ASSET_INTERNAL_BASE_URL ?? 'http://localhost:3002';
    return new PendingBadgeClient(
      new InternalHttpClient({ baseUrl: hrBase, token, caller: 'platform-core' }),
      new InternalHttpClient({ baseUrl: assetBase, token, caller: 'platform-core' }),
    );
  }

  /**
   * 拉取某用户在 hr/asset 的可见待办之和。
   *
   * @param userId 当前用户
   * @returns hr+asset 待办数（失败按 0）
   */
  async fetchRemotePendingTotal(userId: number): Promise<number> {
    const [hrCount, assetCount] = await Promise.all([
      this.fetchOne(this.hr, 'hr', userId),
      this.fetchOne(this.asset, 'asset', userId),
    ]);
    return hrCount + assetCount;
  }

  private async fetchOne(client: InternalHttpClient | null, label: string, userId: number): Promise<number> {
    if (!client) {
      return 0;
    }
    try {
      const response = await client.get(`/internal/v1/approval-requests/pending-count?userId=${userId}`);
      if (!response.ok) {
        this.logger.warn(`门户角标：${label} pending-count HTTP ${response.status}，贡献 0`);
        return 0;
      }
      const body = (await response.json()) as PendingCountBody;
      return typeof body.total === 'number' && Number.isFinite(body.total) ? body.total : 0;
    } catch (error) {
      const message = error instanceof InternalRequestError ? error.message : String(error);
      this.logger.warn(`门户角标：${label} 不可用（${message}），贡献 0`);
      return 0;
    }
  }
}
