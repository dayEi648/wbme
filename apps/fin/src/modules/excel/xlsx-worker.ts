/**
 * Excel CPU 工作线程入口（主 PRD §9.1 / fin PRD §4）。
 *
 * 承载当前请求的解析（ZIP 安全 + 模板识别 + 行解析）与工作簿序列化；
 * 不构成可恢复后台任务，不持久化文件或中间工作簿。任务消息：
 * - { id, kind: 'parse', payload: { buffer: ArrayBuffer } } → ParseResult | ParseFailure
 * - { id, kind: 'build', payload: { groups } } → { buffer: ArrayBuffer }
 * 结果统一回传 { id, ok, result } | { id, ok: false, error: { message } }。
 */
import { parentPort } from 'node:worker_threads';
import { buildExportBuffer, type ExportProjectRow, type ExportSubtotal } from './export-builder';
import { parseImportBuffer, type ParseFailure, type ParseResult } from './import-parser';

/** 工作池任务负载（跨线程传输的纯数据结构） */
export interface XlsxTaskPayload {
  kind: 'parse' | 'build';
  buffer?: ArrayBuffer;
  groups?: Array<{ bizCategoryName: string | null; rows: ExportProjectRow[]; subtotal: ExportSubtotal }>;
}

interface XlsxTaskMessage {
  id: string;
  kind: 'parse' | 'build';
  payload: XlsxTaskPayload;
}

if (parentPort) {
  parentPort.on('message', async (message: XlsxTaskMessage) => {
    try {
      if (message.kind === 'parse') {
        const result = await parseImportBuffer(Buffer.from(message.payload.buffer as ArrayBuffer));
        parentPort?.postMessage({ id: message.id, ok: true, result });
      } else {
        const buffer = await buildExportBuffer(message.payload.groups as NonNullable<XlsxTaskPayload['groups']>);
        // 转移 ArrayBuffer，避免跨线程拷贝
        const transfer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
        parentPort?.postMessage({ id: message.id, ok: true, result: { buffer: transfer } }, [transfer]);
      }
    } catch (error) {
      parentPort?.postMessage({
        id: message.id,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
}

// 类型引用避免未使用告警（parseImportBuffer 的类型用于消息契约文档化）
export type { ParseFailure, ParseResult };
