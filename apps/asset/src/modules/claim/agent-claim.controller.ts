import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import {
  CONSUMABLE_APPLY_HISTORY_FUNCTION_CODE,
  ConsumableRequestQueryDto,
  PROXY_APPLY_FUNCTION_CODE,
  AgentRequestCreateDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { ScopeResolver } from '../../shared/scope-resolver';
import { AgentClaimService } from './agent-claim.service';

/**
 * 代交申领（asset PRD §7；A-20/A-21）。
 * 权限：「代交申领」（proxy_apply，部门/公司档）；历史随「消耗品申领历史记录」
 * 按类型过滤——服务内断言。
 */
@Controller('agent-requests')
export class AgentClaimController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly agentClaims: AgentClaimService,
    private readonly scopes: ScopeResolver,
  ) {}

  /** 提交代交申领（幂等；受领人名单 + 共享清单；不占个人额度） */
  @Post()
  async submit(@CurrentUser() userId: number, @Body() dto: AgentRequestCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    await assertFunctionAccess(this.prisma.client, userId, PROXY_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.agentClaims.submit(operator, dto);
  }

  /** 本人代交申领历史（随「代交申领」权限隐含提供；含受领人名单） */
  @Get('mine')
  async listMine(@CurrentUser() userId: number, @Query() query: ConsumableRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    await assertFunctionAccess(this.prisma.client, userId, PROXY_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.agentClaims.listMine(operator, query);
  }

  /** 范围代交申领历史（「消耗品申领历史记录」部门/公司档） */
  @Get()
  async listHistory(@CurrentUser() userId: number, @Query() query: ConsumableRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    const applicantIds = await this.scopes.resolveHistoryUserIds(userId, CONSUMABLE_APPLY_HISTORY_FUNCTION_CODE);
    return this.agentClaims.listHistory(query, applicantIds);
  }
}
