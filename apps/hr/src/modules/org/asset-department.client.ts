import { Injectable } from '@nestjs/common';
import { InternalHttpClient, InternalRequestError } from '@wbme/server';

/**
 * asset 内部部门接口客户端（主 PRD §9.4，M12）。
 * 部门删除预览/删除事务调用（hr PRD §6：固定资产归属数、确认后置空固定资产的所属部门）。
 * asset 不可用时：预览降级返回 null（hr 侧按 0 展示并提示），删除事务整体中止（不产生部分删除）。
 */

/** asset 内部 base URL（开发默认本地回环；生产 compose 私网 http://asset:3002/internal/v1） */
const ASSET_INTERNAL_BASE_URL = process.env.ASSET_INTERNAL_BASE_URL ?? 'http://localhost:3002/internal/v1';

/** asset 部门接口响应 */
interface AssetDepartmentResult {
  count: number;
  ok: true;
}

@Injectable()
export class AssetDepartmentClient {
  private readonly client: InternalHttpClient | null;

  /** 从部署环境装配内部客户端（令牌缺失/过短 → null，调用时归为依赖错误） */
  constructor() {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? '';
    this.client = token
      ? new InternalHttpClient({ baseUrl: ASSET_INTERNAL_BASE_URL, token, caller: 'hr' })
      : null;
  }

  /**
   * 查询部门固定资产归属数（删除预览）。
   *
   * @param departmentId 部门 id
   * @returns 资产数；asset 不可用（连接失败/超时/非 2xx 响应）返回 null（预览降级展示）
   */
  async countAssets(departmentId: number): Promise<number | null> {
    if (!this.client) {
      return null;
    }
    try {
      const response = await this.client.get(`/departments/${departmentId}/asset-count`);
      // InternalHttpClient 对 4xx/5xx 返回 Response 而不抛错：非 2xx 一律视为依赖错误降级
      // （否则 body.count 为 undefined、deletePreview 静默显示 0——M12 复核修复）
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as AssetDepartmentResult;
      return body.count;
    } catch (error) {
      if (error instanceof InternalRequestError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 置空部门固定资产归属（删除事务内调用；失败抛错使 hr 删除整体中止）。
   *
   * @param departmentId 部门 id
   * @throws SERVICE_UNAVAILABLE asset 不可用或返回错误（删除事务回滚；避免
   *   "hr 删除已提交而 asset 归属未置空"的两侧不一致——M12 复核修复）
   */
  async clearAssignments(departmentId: number): Promise<void> {
    if (!this.client) {
      throw new Error('内部令牌未配置，无法调用 asset 部门接口');
    }
    const response = await this.client.write(`/departments/${departmentId}/clear-assignments`, { method: 'POST', body: {} });
    if (!response.ok) {
      throw new InternalRequestError(
        `asset 置空部门资产归属失败（HTTP ${response.status}）：${departmentId}`,
        `HTTP ${response.status}`,
      );
    }
  }
}
