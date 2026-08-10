import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  frameworkErrors,
  permissionErrors,
  SYSTEM_SETTINGS_FUNCTION_CODE,
} from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../permission/operation-log.util';

/**
 * 系统开放状态管理（主 PRD §2.1、backstage PRD §6）。
 *
 * - 目录结构（系统/板块/功能的归属、排序）由代码目录权威定义（启动对账），
 *   本服务只开放 asset/hr/fin 的 product_status 调整；
 * - backstage 恒开放不可调；BASE 不进入目录（查询/调整返回 404）；
 * - 状态调整不递增 catalog_version（对账语义：product_status 由管理员维护，
 *   目录语义变化才递增）；状态变更即时生效——门户入口与函数权限守卫均实时
 *   读取 product_status（非 OPEN 系统 SYSTEM_NOT_OPEN）；重新开放不改变任何授权；
 * - 变更写操作日志（feature=system_settings，含变更前后值），支持幂等键。
 */

/** 操作日志幂等作用域 */
const IDEMPOTENCY_SCOPE = {
  SYSTEM_STATUS: 'systems.status',
} as const;

@Injectable()
export class SystemStructureService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 系统列表查询（编码/名称/开放状态，按目录排序）。
   *
   * @returns 系统级信息（不含板块/功能明细）
   */
  async listSystems(): Promise<{ systems: Array<{ code: string; name: string; productStatus: 'OPEN' | 'COMING_SOON' }> }> {
    const systems = await this.prisma.client.system.findMany({
      orderBy: { sort: 'asc' },
      select: { code: true, name: true, productStatus: true },
    });
    return { systems };
  }

  /**
   * 调整系统开放状态（asset/hr/fin；backstage 恒开放不可调；BASE 不在目录返回 404）。
   *
   * @param operatorId 操作人 id
   * @param systemCode 系统编码
   * @param productStatus 目标状态（OPEN / COMING_SOON）
   * @param idempotencyKey 可选幂等键
   * @returns ok（重放返回首次结果）
   * @throws RESOURCE_NOT_FOUND 系统未注册；SYSTEM_STATUS_NOT_ADJUSTABLE backstage 不可调
   */
  async updateSystemStatus(
    operatorId: number,
    systemCode: string,
    productStatus: 'OPEN' | 'COMING_SOON',
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload({ systemCode, productStatus });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: SYSTEM_SETTINGS_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.SYSTEM_STATUS,
      idempotencyKey,
      fingerprint,
      run: async (tx) => {
        const system = await tx.system.findUnique({ where: { code: systemCode } });
        if (!system) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (system.code === 'BACKSTAGE') {
          throw new BusinessException(permissionErrors.SYSTEM_STATUS_NOT_ADJUSTABLE);
        }
        const before = system.productStatus;
        if (before !== productStatus) {
          await tx.system.update({ where: { id: system.id }, data: { productStatus, updatedBy: operator.id } });
        }
        return {
          result: { ok: true as const },
          actionType: 'UPDATE',
          summary: `系统状态调整：${system.name}（${system.code}）：${before} → ${productStatus}`,
        };
      },
    });
  }
}
