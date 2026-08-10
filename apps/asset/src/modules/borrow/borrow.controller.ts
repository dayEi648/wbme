import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import {
  BORROW_HISTORY_FUNCTION_CODE,
  BorrowHistoryQueryDto,
  BorrowReturnCreateDto,
  BorrowWriteOffCreateDto,
  createPaginationResponse,
  MY_BORROW_FUNCTION_CODE,
  MyBorrowQueryDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { BorrowService } from './borrow.service';

/**
 * 借还、归还与核销（asset PRD §8；A-23/A-24）。
 * 我的借还/发起归还/发起核销权限：「我的借还」（my_borrow，本人档）；
 * 借还历史：「借还历史记录」（borrow_history，部门/公司档）——服务内断言。
 */
@Controller()
export class BorrowController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly borrow: BorrowService,
    private readonly closures: DepartmentClosureService,
  ) {}

  /** 我的借还（本人档；含受领的代领共享清单只读视图） */
  @Get('my-borrow')
  async listMine(@CurrentUser() userId: number, @Query() query: MyBorrowQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, MY_BORROW_FUNCTION_CODE);
    const result = await this.borrow.listMine(userId, query);
    return { ...createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20), agentShared: result.agentShared };
  }

  /** 发起归还申请（幂等；可申请数量公式校验） */
  @Post('borrow-returns')
  async submitReturn(@CurrentUser() userId: number, @Body() dto: BorrowReturnCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    await assertFunctionAccess(this.prisma.client, userId, MY_BORROW_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.borrow.submitReturn(operator, dto);
  }

  /** 发起核销申请（幂等；遗失/损坏核销不回库） */
  @Post('borrow-write-offs')
  async submitWriteOff(@CurrentUser() userId: number, @Body() dto: BorrowWriteOffCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    await assertFunctionAccess(this.prisma.client, userId, MY_BORROW_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.borrow.submitWriteOff(operator, dto);
  }

  /** 借还历史（「借还历史记录」部门/公司档；DEPARTMENT 按借出部门/发起人/受领人快照闭包过滤） */
  @Get('borrow-records')
  async listHistory(@CurrentUser() userId: number, @Query() query: BorrowHistoryQueryDto): Promise<unknown> {
    const access = await assertFunctionAccess(this.prisma.client, userId, BORROW_HISTORY_FUNCTION_CODE);
    let departmentIds: ReadonlySet<number> | undefined;
    if (access.dataScope === 'DEPARTMENT') {
      departmentIds = await this.closures.closureOfUser(userId);
    }
    const result = await this.borrow.listHistory(query, departmentIds);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }
}
