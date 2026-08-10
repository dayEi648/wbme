import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { AgentSettlementCreateDto, AgentSettlementQueryDto, createPaginationResponse, PROXY_APPLY_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { AgentSettlementService } from './agent-settlement.service';

/**
 * 代领一次性整单结清（asset PRD §7/§8；A-25）。
 * 权限：「代交申领」（proxy_apply，部门/公司档）——服务内断言。
 */
@Controller('agent-settlements')
export class AgentSettlementController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly settlements: AgentSettlementService,
  ) {}

  /** 提交代领结清（幂等；必须覆盖全部未结清数量；同一清单最多一条待审批结清） */
  @Post()
  async submit(@CurrentUser() userId: number, @Body() dto: AgentSettlementCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    await assertFunctionAccess(this.prisma.client, userId, PROXY_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.settlements.submit(operator, dto);
  }

  /** 本人代领结清申请历史 */
  @Get('mine')
  async listMine(@CurrentUser() userId: number, @Query() query: AgentSettlementQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, PROXY_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    const result = await this.settlements.listMine(operator, query);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }
}
