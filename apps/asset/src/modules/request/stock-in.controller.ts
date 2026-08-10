import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import {
  STOCK_IN_APPLY_FUNCTION_CODE,
  STOCK_IN_HISTORY_FUNCTION_CODE,
  createPaginationResponse,
  StockInRequestCreateDto,
  StockInRequestQueryDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { ScopeResolver } from '../../shared/scope-resolver';
import { StockInService } from './stock-in.service';

/**
 * 入库申请（asset PRD §6；A-18）。
 * 提交/本人历史权限：「入库申请」（stock_in_apply，本人档）；范围历史：「入库申请历史记录」
 * （stock_in_history，部门/公司档）——服务内断言。
 */
@Controller('stock-in-requests')
export class StockInController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly stockIn: StockInService,
    private readonly scopes: ScopeResolver,
  ) {}

  /** 提交入库申请（幂等；整单审批；「入库申请」本人档） */
  @Post()
  async submit(@CurrentUser() userId: number, @Body() dto: StockInRequestCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    await assertFunctionAccess(this.prisma.client, userId, STOCK_IN_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.stockIn.submit(operator, dto);
  }

  /** 本人入库申请历史（随「入库申请」权限隐含提供） */
  @Get('mine')
  async listMine(@CurrentUser() userId: number, @Query() query: StockInRequestQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, STOCK_IN_APPLY_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    const result = await this.stockIn.listMine(operator, query);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /** 范围入库申请历史（「入库申请历史记录」部门/公司档） */
  @Get()
  async listHistory(@CurrentUser() userId: number, @Query() query: StockInRequestQueryDto): Promise<unknown> {
    const applicantIds = await this.scopes.resolveHistoryUserIds(userId, STOCK_IN_HISTORY_FUNCTION_CODE);
    const result = await this.stockIn.listHistory(query, applicantIds);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }
}
