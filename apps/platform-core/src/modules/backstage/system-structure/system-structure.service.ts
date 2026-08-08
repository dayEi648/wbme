import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  frameworkErrors,
  permissionErrors,
  SYSTEM_STRUCTURE_MANAGE_FUNCTION_CODE,
} from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../permission/operation-log.util';

/**
 * 系统与业务结构管理（backstage PRD §6、主 PRD §3.1；实现规划 T3-7）。
 *
 * - 目录结构（系统/板块/功能的归属、排序、启停以外的定义）由代码目录权威定义（T3-1 启动对账），
 *   本服务只开放：asset/hr/fin 的 product_status 调整、板块/功能的业务说明 description 维护；
 * - backstage 恒开放不可调；BASE 不进入目录（查询/调整返回 404）；
 * - 状态与说明调整不递增 catalog_version（对账语义：product_status 由管理员维护、description
 *   对账不覆盖；目录语义变化才递增，T3-1）；状态变更即时生效——门户入口与函数权限守卫均实时
 *   读取 product_status（T3-4：非 OPEN 系统 SYSTEM_NOT_OPEN）；重新开放不改变任何授权；
 * - 变更写操作日志（feature=system_structure_manage，含变更前后值），支持幂等键。
 */

/** 操作日志幂等作用域 */
const IDEMPOTENCY_SCOPE = {
  SYSTEM_STATUS: 'systems.status',
  SECTION_DESCRIPTION: 'systems.section-description',
  FUNCTION_DESCRIPTION: 'systems.function-description',
} as const;

/** 结构树功能项 */
export interface FunctionNode {
  code: string;
  name: string;
  description: string | null;
  dataScopeOptions: string[];
  sort: number;
}

/** 结构树板块项 */
export interface SectionNode {
  code: string;
  name: string;
  description: string | null;
  sort: number;
  functions: FunctionNode[];
}

/** 结构树系统项 */
export interface SystemNode {
  code: string;
  name: string;
  productStatus: 'OPEN' | 'COMING_SOON';
  sort: number;
  sections: SectionNode[];
}

@Injectable()
export class SystemStructureService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 系统与业务结构树查询（系统 → 板块 → 功能，按目录排序）。
   *
   * @returns 全量结构树（目录注册表当前状态，约数十行）
   */
  async listStructure(): Promise<{ systems: SystemNode[] }> {
    const systems = await this.prisma.client.system.findMany({
      orderBy: { sort: 'asc' },
      include: {
        sections: {
          orderBy: { sort: 'asc' },
          include: { functions: { orderBy: { sort: 'asc' } } },
        },
      },
    });
    return {
      systems: systems.map((system) => ({
        code: system.code,
        name: system.name,
        productStatus: system.productStatus,
        sort: system.sort,
        sections: system.sections.map((section) => ({
          code: section.code,
          name: section.name,
          description: section.description,
          sort: section.sort,
          functions: section.functions.map((fn) => ({
            code: fn.code,
            name: fn.name,
            description: fn.description,
            dataScopeOptions: fn.dataScopeOptions,
            sort: fn.sort,
          })),
        })),
      })),
    };
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
      feature: SYSTEM_STRUCTURE_MANAGE_FUNCTION_CODE,
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

  /**
   * 维护业务板块的业务说明（description；排序/归属由代码目录定义，不开放调整）。
   *
   * @param operatorId 操作人 id
   * @param systemCode 系统编码
   * @param sectionCode 板块编码
   * @param description 新说明（空白字符串 = 清除为 NULL）
   * @param idempotencyKey 可选幂等键
   * @returns ok
   * @throws RESOURCE_NOT_FOUND 系统/板块未注册
   */
  async updateSectionDescription(
    operatorId: number,
    systemCode: string,
    sectionCode: string,
    description: string,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const next = description.trim().length === 0 ? null : description.trim();
    const fingerprint = fingerprintPayload({ systemCode, sectionCode, description: next });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: SYSTEM_STRUCTURE_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.SECTION_DESCRIPTION,
      idempotencyKey,
      fingerprint,
      run: async (tx) => {
        const section = await tx.businessSection.findFirst({
          where: { code: sectionCode, system: { code: systemCode } },
          include: { system: { select: { name: true } } },
        });
        if (!section) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // description 变化不改变授权语义，不递增 catalog_version（主 PRD §3.1；对账不覆盖管理员维护值）
        await tx.businessSection.update({ where: { id: section.id }, data: { description: next, updatedBy: operator.id } });
        return {
          result: { ok: true as const },
          actionType: 'UPDATE',
          summary: `维护板块说明：${section.system.name}/${section.name}：变更前 [${section.description ?? ''}]，变更后 [${next ?? ''}]`,
        };
      },
    });
  }

  /**
   * 维护功能的业务说明（description；授权界面悬停展示）。
   *
   * @param operatorId 操作人 id
   * @param functionCode 稳定功能编码
   * @param description 新说明（空白字符串 = 清除为 NULL）
   * @param idempotencyKey 可选幂等键
   * @returns ok
   * @throws RESOURCE_NOT_FOUND 功能未注册
   */
  async updateFunctionDescription(
    operatorId: number,
    functionCode: string,
    description: string,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const next = description.trim().length === 0 ? null : description.trim();
    const fingerprint = fingerprintPayload({ functionCode, description: next });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: SYSTEM_STRUCTURE_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.FUNCTION_DESCRIPTION,
      idempotencyKey,
      fingerprint,
      run: async (tx) => {
        const fn = await tx.function.findUnique({ where: { code: functionCode } });
        if (!fn) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await tx.function.update({ where: { id: fn.id }, data: { description: next, updatedBy: operator.id } });
        return {
          result: { ok: true as const },
          actionType: 'UPDATE',
          summary: `维护功能说明：${fn.name}（${fn.code}）：变更前 [${fn.description ?? ''}]，变更后 [${next ?? ''}]`,
        };
      },
    });
  }
}
