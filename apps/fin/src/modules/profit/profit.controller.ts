import { Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { ProfitCellSaveDto, ProjectQueryDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFinanceMaintainAccess, assertFinanceReadAccess } from '../../shared/cross-schema-auth';
import { loadFinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { ProfitService } from './profit.service';

/**
 * 利润分析（fin PRD §4）。
 * 只读（列表/总计）= 财务数据查看（维护隐含包含）；单元格即时保存 = 财务数据维护。
 */
@Controller('profit')
export class ProfitController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly profit: ProfitService,
  ) {}

  /** 利润分析列表（筛选分页 + 每行自动计算字段） */
  @Get('projects')
  async list(@CurrentUser() userId: number, @Query() query: ProjectQueryDto): Promise<unknown> {
    await assertFinanceReadAccess(this.prisma.client, userId);
    return this.profit.list(query);
  }

  /** 总计汇总（当前筛选结果；不受当前页分页影响，随筛选实时计算） */
  @Get('totals')
  async totals(@CurrentUser() userId: number, @Query() query: ProjectQueryDto): Promise<unknown> {
    await assertFinanceReadAccess(this.prisma.client, userId);
    return this.profit.totals(query);
  }

  /** 单元格即时保存（单字段白名单 + 幂等键；响应携带重算自动字段与 dataRevision） */
  @Put('cells')
  async cellSave(@CurrentUser() userId: number, @Body() dto: ProfitCellSaveDto): Promise<unknown> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.profit.cellSave(operator, dto);
  }
}
