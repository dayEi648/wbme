import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { BusinessException, financeErrors, frameworkErrors, ImportConfirmDto, ProjectQueryDto } from '@wbme/contracts';
import { CurrentUser, RequestTimeout } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFinanceMaintainAccess, assertFinanceReadAccess } from '../../shared/cross-schema-auth';
import { loadFinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { ExportService } from './export.service';
import { ImportService } from './import.service';

/** 上传文件固定上限：20 MiB（fin PRD §4 MVP 固定值；Multer 层先拦截） */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

/** Excel 导入/导出路由超时：业务总时限 120s + 30s 缓冲（全局默认 30s 会提前截断长任务） */
const EXCEL_ROUTE_TIMEOUT_MS = 150_000;

/**
 * 利润分析 Excel 导入/导出（fin PRD §4）。
 * 权限：导入与导出 = 财务数据维护（导出按 PRD §1 查看人员亦可导出，controller 分别断言）。
 */
@Controller('profit/excel')
export class ExcelController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly imports: ImportService,
    private readonly exports: ExportService,
  ) {}

  /** 导入预览（multipart 单文件；服务端当前请求内解析校验，不写入正式表、不保留文件） */
  @Post('import/preview')
  @RequestTimeout(EXCEL_ROUTE_TIMEOUT_MS)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_BYTES } }))
  async importPreview(
    @CurrentUser() userId: number,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    if (!file) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field: 'file', reason: '缺少上传文件' }] });
    }
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.imports.preview(operator, file.buffer, abortSignal(req, res));
  }

  /** 导入确认（携带选择映射与幂等键；服务端重新解析同一文件后集合化批量写入，全有或全无） */
  @Post('import/confirm')
  @RequestTimeout(EXCEL_ROUTE_TIMEOUT_MS)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_BYTES } }))
  async importConfirm(
    @CurrentUser() userId: number,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body() dto: ImportConfirmDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    await assertFinanceMaintainAccess(this.prisma.client, userId);
    if (!file) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field: 'file', reason: '缺少上传文件' }] });
    }
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.imports.confirm(operator, file.buffer, dto.choices, dto.idempotencyKey, abortSignal(req, res));
  }

  /** 导出（导出所有/导出已筛选；固定 V2 模板；附件直接响应） */
  @Get('export/:scope')
  @RequestTimeout(EXCEL_ROUTE_TIMEOUT_MS)
  async export(
    @CurrentUser() userId: number,
    @Param('scope') scope: string,
    @Query() query: ProjectQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await assertFinanceReadAccess(this.prisma.client, userId);
    if (scope !== 'all' && scope !== 'filtered') {
      throw new BusinessException(financeErrors.IMPORT_SHEET_INVALID, { fields: [{ field: 'scope', reason: '导出范围只支持 all/filtered' }] });
    }
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    await this.exports.export(operator, res, scope, query, abortSignal(req, res));
  }
}

/** 请求取消信号（客户端断连或响应关闭时传播取消；worker 排队任务丢弃、执行任务终止） */
export function abortSignal(req: Request, res: Response): AbortSignal | undefined {
  const controller = new AbortController();
  const onAborted = (): void => controller.abort();
  req.on('aborted', onAborted);
  // 响应侧关闭（路由超时/客户端断开/代理断连）才是实际取消源；请求体读完后 req 'close' 已不可靠
  res.on('close', onAborted);
  return controller.signal;
}
