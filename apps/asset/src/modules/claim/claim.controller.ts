import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import {
  CONSUMABLE_APPLY_FUNCTION_CODE,
  CONSUMABLE_APPLY_HISTORY_FUNCTION_CODE,
  ConsumableRequestCreateDto,
  ConsumableRequestQueryDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { ScopeResolver } from '../../shared/scope-resolver';
import { ClaimService } from './claim.service';

/**
 * 普通消耗品申领（asset PRD §7；A-20/A-22）。
 * 提交/本人历史权限：「消耗品申领」（consumable_apply，本人档）；范围历史：
 * 「消耗品申领历史记录」（consumable_apply_history，部门/公司档）——服务内断言。
 */
@Controller('consumable-requests')
export class ClaimController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly scopes: ScopeResolver,
  ) {}

  /** 提交普通申领（幂等；库存占用 + 额度占用原子；整单全有或全无） */
  @Post()
  async submit(@CurrentUser() userId: number, @Body() dto: ConsumableRequestCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    await assertFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.claims.submit(operator, dto);
  }

  /** 本人申领历史（随「消耗品申领」权限隐含提供） */
  @Get('mine')
  async listMine(@CurrentUser() userId: number, @Query() query: ConsumableRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    await assertFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.claims.listMine(operator, query);
  }

  /** 范围申领历史（「消耗品申领历史记录」部门/公司档） */
  @Get()
  async listHistory(@CurrentUser() userId: number, @Query() query: ConsumableRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    const applicantIds = await this.scopes.resolveHistoryUserIds(userId, CONSUMABLE_APPLY_HISTORY_FUNCTION_CODE);
    return this.claims.listHistory(query, applicantIds);
  }
}
