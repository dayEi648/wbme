import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { CONSUMABLE_APPROVAL_FUNCTION_CODE, DirectDisposalDto, DisposalQueryDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { DisposalService } from './disposal.service';

/**
 * 注销员工借还处置（asset PRD §8/§9：审批中心「注销员工借还处置」功能）。
 * 权限：「消耗品审批」（consumable_approval，部门/公司档）；操作本身不是审批申请，
 * 不计入六类待办数量——服务内断言。
 */
@Controller('disposals')
export class DisposalController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly disposals: DisposalService,
  ) {}

  /** 待处置 / 处置记录（PENDING / RECORDS 两个视图） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: DisposalQueryDto): Promise<{ items: unknown[]; total: number }> {
    if (query.tab === 'RECORDS') {
      return this.disposals.listRecords(userId, query);
    }
    return this.disposals.listPending(userId, query);
  }

  /** 直接处置（幂等；RETURN 回库 / WRITE_OFF 核销 / AGENT_SETTLE 整单结清） */
  @Post()
  async dispose(@CurrentUser() userId: number, @Body() dto: DirectDisposalDto): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPROVAL_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    await this.disposals.dispose(operator, userId, dto);
    return { ok: true };
  }
}
