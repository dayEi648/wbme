import { Injectable } from '@nestjs/common';
import {
  BusinessException,
  frameworkErrors,
  getErrorEntry,
  integrationErrors,
} from '@wbme/contracts';
import { InternalHttpClient, InternalRequestError } from '@wbme/server';

/**
 * hr 组织身份内部接口客户端（base PRD §6 个人中心 P2/P4/P5 承接）。
 *
 * 契约：
 * - GET  /internal/v1/users/{userId}/org：当前身份部门/岗位/可否自助申请（P2）；
 * - POST /internal/v1/position-applications：提交岗位变更申请（P4，携带幂等键）；
 * - GET  /internal/v1/position-applications?userId=&page=&pageSize=：我的申请记录（P5）。
 * P2 为只读展示：hr 不可用时优雅降级为空身份（不 503）；
 * P4 为写入：hr 不可用 → 503（HR_SERVICE_UNAVAILABLE），4xx 保留 hr 业务码原样抛出。
 */
export interface HrOrgIdentity {
  departmentIds: number[];
  departmentNames: string[];
  positionId: number | null;
  positionName: string | null;
  canApplyPositionChange: boolean;
}

/** 我的岗位申请记录行（P5） */
export interface HrPositionApplicationItem {
  requestId: number;
  applicationNo: string;
  status: string;
  targetDepartmentName: string | null;
  targetPositionName: string | null;
  submittedAt: string | null;
  processedAt: string | null;
  opinion: string | null;
}

/** hr 服务内部地址（开发默认本地回环；生产 compose 私网 http://hr:43003） */
const HR_INTERNAL_BASE_URL = process.env.HR_INTERNAL_BASE_URL ?? 'http://localhost:43003';

@Injectable()
export class HrOrgClient {
  /** 内部 REST 客户端；null = 未配置（P2 降级空身份；P4 归一 HR_SERVICE_UNAVAILABLE） */
  private readonly client: InternalHttpClient | null;

  /**
   * 显式注入内部客户端（DI 由模块工厂装配；不允许 Nest 按类型解析 InternalHttpClient）。
   *
   * @param client 内部客户端或 null
   */
  constructor(client: InternalHttpClient | null) {
    this.client = client;
  }

  /** 从部署环境装配内部客户端（令牌缺失/过短 → null） */
  static fromEnv(): HrOrgClient {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? '';
    const client = token ? new InternalHttpClient({ baseUrl: HR_INTERNAL_BASE_URL, token, caller: 'platform-core' }) : null;
    return new HrOrgClient(client);
  }

  /**
   * P2 当前身份组织信息（只读展示；hr 不可用 → 空身份优雅降级，不 503）。
   *
   * @param userId 当前用户
   * @returns 组织身份（hr 降级时为空结构）
   */
  async getMyOrg(userId: number): Promise<HrOrgIdentity> {
    if (!this.client) {
      return emptyIdentity();
    }
    try {
      const response = await this.client.get(`/internal/v1/users/${userId}/org`);
      if (!response.ok) {
        return emptyIdentity();
      }
      const body = (await response.json()) as Partial<HrOrgIdentity>;
      return {
        departmentIds: Array.isArray(body.departmentIds) ? body.departmentIds : [],
        departmentNames: Array.isArray(body.departmentNames) ? body.departmentNames : [],
        positionId: typeof body.positionId === 'number' ? body.positionId : null,
        positionName: typeof body.positionName === 'string' ? body.positionName : null,
        canApplyPositionChange: body.canApplyPositionChange === true,
      };
    } catch (error) {
      if (error instanceof InternalRequestError) {
        return emptyIdentity();
      }
      throw error;
    }
  }

  /**
   * P4 提交岗位变更申请（写入：hr 不可用 → HR_SERVICE_UNAVAILABLE；hr 业务拒绝保留码）。
   *
   * @param userId 当前用户（实际操作者）
   * @param input 目标部门/岗位与幂等键
   * @returns 审批头标识
   */
  async submitPositionApplication(
    userId: number,
    input: { targetDepartmentId: number; targetPositionId: number; idempotencyKey?: string },
  ): Promise<{ requestId: number; applicationNo: string }> {
    const body = await this.writeWithBusinessErrors('/internal/v1/position-applications', {
      userId,
      targetDepartmentId: input.targetDepartmentId,
      targetPositionId: input.targetPositionId,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    if (typeof body !== 'object' || body === null || typeof (body as { requestId?: unknown }).requestId !== 'number') {
      throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
    }
    return body as { requestId: number; applicationNo: string };
  }

  /**
   * P5 我的岗位申请记录（分页）。
   *
   * @param userId 当前用户
   * @param page 页码
   * @param pageSize 每页条数
   * @returns 统一分页结构
   */
  async listPositionApplications(userId: number, page: number, pageSize: number): Promise<unknown> {
    if (!this.client) {
      return { data: [], pagination: { page, pageSize, totalItems: 0, totalPages: 0 } };
    }
    try {
      const response = await this.client.get(
        `/internal/v1/position-applications?userId=${userId}&page=${page}&pageSize=${pageSize}`,
      );
      if (!response.ok) {
        return { data: [], pagination: { page, pageSize, totalItems: 0, totalPages: 0 } };
      }
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof InternalRequestError) {
        return { data: [], pagination: { page, pageSize, totalItems: 0, totalPages: 0 } };
      }
      throw error;
    }
  }

  /**
   * 写入调用（幂等键使有界重试安全）：4xx 解析 hr 错误体并保留业务码重抛；
   * 连接失败/超时/5xx/无效响应 → HR_SERVICE_UNAVAILABLE。
   */
  private async writeWithBusinessErrors(path: string, body: unknown): Promise<unknown> {
    if (!this.client) {
      throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
    }
    let response: Response;
    try {
      response = await this.client.write(path, {
        method: 'POST',
        body,
        idempotencyKey: (body as { idempotencyKey?: string }).idempotencyKey,
      });
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
      // hr 已正常响应 4xx：保留其业务域错误码与文案（主 PRD §9.4：不得笼统改写为依赖不可用）
      const error = (parsed as { error?: { type?: string; domain?: string; code?: string } })?.error;
      if (error?.code) {
        // 业务码须来自共享错误目录（hr 域在 contracts 已注册），未注册的码按通用冲突处理
        const entry = getErrorEntry(error.type as never, error.domain as never, error.code);
        if (entry) {
          throw new BusinessException(entry);
        }
      }
      throw new BusinessException(frameworkErrors.CONFLICT);
    }
    return parsed;
  }
}

/** 空组织身份（hr 不可用时的 P2 降级展示） */
function emptyIdentity(): HrOrgIdentity {
  return {
    departmentIds: [],
    departmentNames: [],
    positionId: null,
    positionName: null,
    canApplyPositionChange: false,
  };
}
