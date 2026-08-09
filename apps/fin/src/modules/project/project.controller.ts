import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  BusinessException,
  FinanceDetailCreateDto,
  FinanceDetailUpdateDto,
  frameworkErrors,
  ProjectBatchDeleteDto,
  ProjectBatchRestoreDto,
  ProjectCreateDto,
  ProjectOperationQueryDto,
  ProjectQueryDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFinanceMaintainAccess, assertFinanceReadAccess } from '../../shared/cross-schema-auth';
import { loadFinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { DetailService } from './detail.service';
import { ProjectOperationService } from './project-operation.service';
import { ProjectService } from './project.service';

/**
 * 工程合同（fin PRD §3；F-1）。
 * 权限：只读 = 财务数据查看（维护隐含包含）；写 = 财务数据维护。
 */
@Controller('projects')
export class ProjectController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly projects: ProjectService,
    private readonly details: DetailService,
    private readonly operations: ProjectOperationService,
  ) {}

  /** 项目列表（正常/已删除视图；筛选分页） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: ProjectQueryDto): Promise<unknown> {
    await assertFinanceReadAccess(this.prisma.client, userId);
    return this.projects.list(query, query.view === 'deleted');
  }

  /** 项目新建 */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: ProjectCreateDto): Promise<{ id: number }> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.projects.create(operator, dto);
  }

  /** 项目详情（完整合同资料 + 三类明细 + 自动字段与利润数据入口） */
  @Get(':id')
  async getDetail(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    await assertFinanceReadAccess(this.prisma.client, userId);
    return this.projects.getDetail(id);
  }

  /** 已删除项目批量恢复（先于 :id 路由声明，避免路径冲突；只提供批量恢复） */
  @Put('deleted/restore')
  async batchRestore(@CurrentUser() userId: number, @Body() dto: ProjectBatchRestoreDto): Promise<{ restored: number }> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.projects.batchRestore(operator, dto.ids);
  }

  /** 项目编辑（名称/年度允许随时修改） */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ProjectCreateDto,
  ): Promise<{ id: number }> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.projects.update(operator, id, dto);
  }

  /** 批量软删除（全有或全无；已删除项目不进入正常列表/筛选/统计/导出） */
  @Delete('batch')
  async batchDelete(@CurrentUser() userId: number, @Body() dto: ProjectBatchDeleteDto): Promise<{ deleted: number }> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.projects.batchDelete(operator, dto.ids);
  }

  /** 金额明细新增（invoice/receipt/subcontract-payment；每次一条） */
  @Post(':projectId/details/:kind')
  async createDetail(
    @CurrentUser() userId: number,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('kind') kind: string,
    @Body() dto: FinanceDetailCreateDto,
  ): Promise<{ id: number }> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.details.create(operator, projectId, assertDetailKind(kind), dto);
  }

  /** 金额明细修改（每次一条） */
  @Put(':projectId/details/:kind/:detailId')
  async updateDetail(
    @CurrentUser() userId: number,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('kind') kind: string,
    @Param('detailId', ParseIntPipe) detailId: number,
    @Body() dto: FinanceDetailUpdateDto,
  ): Promise<{ id: number }> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.details.update(operator, projectId, assertDetailKind(kind), detailId, dto);
  }

  /** 金额明细单条物理删除（删除前完整快照审计同事务；删除后不可恢复） */
  @Delete(':projectId/details/:kind/:detailId')
  async removeDetail(
    @CurrentUser() userId: number,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('kind') kind: string,
    @Param('detailId', ParseIntPipe) detailId: number,
  ): Promise<{ ok: true }> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.details.remove(operator, projectId, assertDetailKind(kind), detailId);
  }
}

/**
 * 项目操作记录（fin PRD §5；F-5）。
 * 权限：随“财务数据查看”开放（财务数据维护隐含包含）；只读列表与详情。
 */
@Controller('project-operations')
export class ProjectOperationController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly operations: ProjectOperationService,
  ) {}

  /** 操作记录列表（时间倒序；可按项目过滤） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: ProjectOperationQueryDto): Promise<unknown> {
    await assertFinanceReadAccess(this.prisma.client, userId);
    return this.operations.list(query);
  }

  /** 操作记录详情（按字段展示变更前后内容） */
  @Get(':id')
  async getDetail(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    await assertFinanceReadAccess(this.prisma.client, userId);
    const row = await this.operations.getDetail(id);
    if (!row) {
      return null;
    }
    return row;
  }
}

/** 明细类型白名单校验（非法类型按 404 处理，不泄露接口细节） */
function assertDetailKind(kind: string): 'invoice' | 'receipt' | 'subcontract-payment' {
  if (kind === 'invoice' || kind === 'receipt' || kind === 'subcontract-payment') {
    return kind;
  }
  throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
}
