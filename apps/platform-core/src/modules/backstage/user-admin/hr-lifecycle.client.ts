import { Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors, integrationErrors } from '@wbme/contracts';
import { InternalHttpClient, InternalRequestError } from '@wbme/server';

/**
 * hr 账号生命周期内部接口客户端（backstage PRD §3、主 PRD §9.4）。
 *
 * 契约（详见 docs/api-documentations/backstage-users.md「hr 内部接口契约」）：
 * - POST /internal/v1/lifecycle/restore-preview：恢复兼容性预览（组织关系侧）；
 * - POST /internal/v1/lifecycle/restore-apply：幂等恢复应用（稳定恢复请求 ID 去重，整批全有或全无）；
 * - 两接口均按 restoreRequestId 幂等；4xx 表示整批拒绝（目标已变化等），5xx/超时/连接失败/
 *   无效响应统一归为 HR_SERVICE_UNAVAILABLE（此时任何账号不得发生变更）。
 */
export interface HrRestoreTarget {
  /** 目标用户 id */
  userId: number;
  /** 注销时间（ISO 8601；hr 据此幂等取消注销前已提交且仍待审批的岗位申请） */
  deactivatedAt: string;
  /** 恢复确认携带的账号生命周期版本 */
  lifecycleVersion: number;
}

/** hr 预览返回的逐目标组织兼容性结果 */
export interface HrRestorePreviewItem {
  userId: number;
  /** hr 侧是否可恢复（组织兼容性检查通过） */
  restorable: boolean;
  /** 不可恢复原因码（hr 侧定义） */
  blockedReasonCode?: string;
  /** 将被清除的部门名称快照（部门已删除/停用的关系） */
  removedDepartmentNames?: string[];
  /** 岗位将被置空（岗位不存在或不再适用于全部保留部门） */
  positionCleared?: boolean;
}

export interface HrRestorePreviewResponse {
  targets: HrRestorePreviewItem[];
}

/** hr 恢复应用响应（整批成功） */
export interface HrRestoreApplyResponse {
  applied: true;
}

/** hr 内部接口访问口（注入替身便于测试；生产实现走内部 REST） */
export interface HrLifecycleGateway {
  restorePreview(restoreRequestId: string, targets: HrRestoreTarget[]): Promise<HrRestorePreviewResponse>;
  restoreApply(restoreRequestId: string, targets: HrRestoreTarget[]): Promise<HrRestoreApplyResponse>;
}

/** hr 服务内部地址（开发默认本地回环；生产 compose 私网 http://hr:43003） */
const HR_INTERNAL_BASE_URL = process.env.HR_INTERNAL_BASE_URL ?? 'http://localhost:43003';

@Injectable()
export class HrLifecycleClient implements HrLifecycleGateway {
  /** 内部 REST 客户端；null = 未配置（调用即 HR_SERVICE_UNAVAILABLE） */
  private readonly client: InternalHttpClient | null;

  /**
   * 显式注入内部客户端（DI 由模块工厂装配，见 user-admin.module.ts；测试注入替身）。
   * 不允许 Nest 按类型解析本参数（InternalHttpClient 不是可注入 provider）。
   */
  constructor(client: InternalHttpClient | null) {
    this.client = client;
  }

  /** 从部署环境装配内部客户端（令牌缺失/过短 → null，调用时归一 HR_SERVICE_UNAVAILABLE） */
  static fromEnv(): HrLifecycleClient {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? '';
    const client = token ? new InternalHttpClient({ baseUrl: HR_INTERNAL_BASE_URL, token, caller: 'platform-core' }) : null;
    return new HrLifecycleClient(client);
  }

  /** 恢复预览（组织兼容性检查）；hr 未就绪/超时/无效响应 → HR_SERVICE_UNAVAILABLE */
  async restorePreview(restoreRequestId: string, targets: HrRestoreTarget[]): Promise<HrRestorePreviewResponse> {
    const body = await this.call('/lifecycle/restore-preview', restoreRequestId, { restoreRequestId, targets });
    if (typeof body !== 'object' || body === null || !Array.isArray((body as { targets?: unknown }).targets)) {
      throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
    }
    return body as HrRestorePreviewResponse;
  }

  /** 幂等恢复应用（整批全有或全无；同 restoreRequestId 重试返回原结果）；4xx → CONFLICT（调用方重新预览） */
  async restoreApply(restoreRequestId: string, targets: HrRestoreTarget[]): Promise<HrRestoreApplyResponse> {
    const body = await this.call('/lifecycle/restore-apply', restoreRequestId, { restoreRequestId, targets });
    if (typeof body !== 'object' || body === null || (body as { applied?: unknown }).applied !== true) {
      throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
    }
    return body as HrRestoreApplyResponse;
  }

  /**
   * 内部调用与错误归一（主 PRD §9.4）：连接失败/超时/5xx/无效响应 → HR_SERVICE_UNAVAILABLE；
   * 4xx 业务拒绝保留冲突语义（CONFLICT，恢复方重新预览）；幂等键使有界重试安全。
   */
  private async call(path: string, idempotencyKey: string, body: unknown): Promise<unknown> {
    if (!this.client) {
      throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
    }
    let response: Response;
    try {
      response = await this.client.write(`/internal/v1${path}`, { method: 'POST', body, idempotencyKey });
    } catch (error) {
      if (error instanceof InternalRequestError) {
        throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
      }
      throw error;
    }
    if (response.status >= 500) {
      throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
    }
    if (!response.ok) {
      // hr 已正常响应 4xx：整批拒绝（目标已变化/不可处理），恢复方须重新预览（主 PRD §9.4 保留业务语义）
      throw new BusinessException(frameworkErrors.CONFLICT);
    }
    return parsed;
  }
}
