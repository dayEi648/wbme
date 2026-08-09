import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import {
  STOCK_CHANGE_APPLY_FUNCTION_CODE,
  STOCK_CHANGE_HISTORY_FUNCTION_CODE,
  StockChangeRequestCreateDto,
  StockChangeRequestQueryDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { ScopeResolver } from '../../shared/scope-resolver';
import { StockChangeService } from './stock-change.service';

/**
 * 库存变更申请（asset PRD §6；A-19：仅意外扣减，MVP 不支持增加库存）。
 * 提交/本人历史权限：「库存变更申请」（stock_change_apply，本人档）；范围历史：
 * 「库存变更申请历史记录」（stock_change_history，部门/公司档）——服务内断言。
 */
@Controller('stock-change-requests')
export class StockChangeController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly stockChange: StockChangeService,
    private readonly scopes: ScopeResolver,
  ) {}

  /** 提交库存变更申请（幂等；整单占用、全有或全无） */
  @Post()
  async submit(@CurrentUser() userId: number, @Body() dto: StockChangeRequestCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    await assertFunctionAccess(this.prisma.client, userId, STOCK_CHANGE_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.stockChange.submit(operator, dto);
  }

  /** 本人库存变更申请历史（随「库存变更申请」权限隐含提供） */
  @Get('mine')
  async listMine(@CurrentUser() userId: number, @Query() query: StockChangeRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    await assertFunctionAccess(this.prisma.client, userId, STOCK_CHANGE_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.stockChange.listMine(operator, query);
  }

  /** 范围库存变更申请历史（「库存变更申请历史记录」部门/公司档） */
  @Get()
  async listHistory(@CurrentUser() userId: number, @Query() query: StockChangeRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    const applicantIds = await this.scopes.resolveHistoryUserIds(userId, STOCK_CHANGE_HISTORY_FUNCTION_CODE);
    return this.stockChange.listHistory(query, applicantIds);
  }
}
