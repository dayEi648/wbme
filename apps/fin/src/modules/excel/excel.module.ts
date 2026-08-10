import { Module } from '@nestjs/common';
import { ExcelController } from './excel.controller';
import { ExcelImportLockGuard } from './excel-import-lock.guard';
import { ExportService } from './export.service';
import { ImportService } from './import.service';
import { XlsxWorkerPool } from './xlsx-worker-pool';

/**
 * 利润分析 Excel 模块：导入（预览/确认）与固定模板导出。
 * XlsxWorkerPool 为有界 CPU 工作池（2 线程），模块内共享。
 */
@Module({
  controllers: [ExcelController],
  providers: [XlsxWorkerPool, ImportService, ExportService, ExcelImportLockGuard],
})
export class ExcelModule {}
