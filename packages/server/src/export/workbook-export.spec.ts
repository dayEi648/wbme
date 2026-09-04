import { PassThrough } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { sanitizeExportCell } from './export-cell-sanitize';
import { runExport, type ExportSheetOptions } from './workbook-export';

interface ZipEntry {
  name: string;
  crc32: number;
  uncompressedSize: number;
  content: string;
}

/** 从 ZIP 中央目录读取条目：验证流式响应的目录字段与 XML 内容均完整。 */
function readZipEntries(archive: Buffer): Map<string, ZipEntry> {
  const centralDirectorySignature = Buffer.from('PK\x01\x02');
  const localFileSignature = 0x04034b50;
  const entries = new Map<string, ZipEntry>();
  let cursor = 0;

  while (cursor < archive.length) {
    const centralDirectoryOffset = archive.indexOf(centralDirectorySignature, cursor);
    if (centralDirectoryOffset === -1) break;
    const compressionMethod = archive.readUInt16LE(centralDirectoryOffset + 10);
    const crc32 = archive.readUInt32LE(centralDirectoryOffset + 16);
    const compressedSize = archive.readUInt32LE(centralDirectoryOffset + 20);
    const uncompressedSize = archive.readUInt32LE(centralDirectoryOffset + 24);
    const fileNameLength = archive.readUInt16LE(centralDirectoryOffset + 28);
    const extraFieldLength = archive.readUInt16LE(centralDirectoryOffset + 30);
    const fileCommentLength = archive.readUInt16LE(centralDirectoryOffset + 32);
    const localFileOffset = archive.readUInt32LE(centralDirectoryOffset + 42);
    const nameStart = centralDirectoryOffset + 46;
    const name = archive.subarray(nameStart, nameStart + fileNameLength).toString('utf8');

    expect(archive.readUInt32LE(localFileOffset)).toBe(localFileSignature);
    const localNameLength = archive.readUInt16LE(localFileOffset + 26);
    const localExtraFieldLength = archive.readUInt16LE(localFileOffset + 28);
    const compressedDataStart = localFileOffset + 30 + localNameLength + localExtraFieldLength;
    const compressedData = archive.subarray(compressedDataStart, compressedDataStart + compressedSize);
    const content = compressionMethod === 8
      ? inflateRawSync(compressedData).toString('utf8')
      : compressedData.toString('utf8');
    entries.set(name, { name, crc32, uncompressedSize, content });
    cursor = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }

  return entries;
}

/** 收集 Express 响应等价 Writable 输出，供验证二进制响应而非只验证调用次数。 */
function createResponseCapture(): {
  response: never;
  completed: Promise<Buffer>;
  headers: Map<string, string>;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  const headers = new Map<string, string>();
  stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => {
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
  Object.assign(stream, {
    setHeader: (name: string, value: string): void => {
      headers.set(name.toLowerCase(), value);
    },
  });
  return { response: stream as never, completed, headers };
}

async function exportRows(
  rows: Array<{ employeeName: string }>,
  sheet?: ExportSheetOptions,
): Promise<{ archive: Buffer; headers: Map<string, string> }> {
  const capture = createResponseCapture();
  await runExport<{ employeeName: string }>({
    userId: 1,
    redis: {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
    } as never,
    maxRows: 100,
    filename: 'overtime-records.xlsx',
    columns: [
      { header: '员工姓名', value: (row) => row.employeeName },
      { header: '加班日期', value: () => '2026-09-04' },
    ],
    sheet,
    fetchCount: async () => rows.length,
    fetchRows: async (_tx, offset, limit) => rows.slice(offset, offset + limit),
    transaction: async (callback) => callback({}),
    res: capture.response,
  });
  return { archive: await capture.completed, headers: capture.headers };
}

function expectValidWorkbookArchive(archive: Buffer): Map<string, ZipEntry> {
  const entries = readZipEntries(archive);
  const requiredEntries = [
    '[Content_Types].xml',
    '_rels/.rels',
    'docProps/app.xml',
    'docProps/core.xml',
    'xl/workbook.xml',
    'xl/styles.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/theme/theme1.xml',
    'xl/worksheets/sheet1.xml',
  ];
  for (const name of requiredEntries) {
    const entry = entries.get(name);
    expect(entry, `缺少 OOXML 条目：${name}`).toBeDefined();
    expect(entry?.crc32, `${name} 的 CRC 不能为零`).toBeGreaterThan(0);
    expect(entry?.uncompressedSize, `${name} 的未压缩大小不能为零`).toBeGreaterThan(0);
    expect(entry?.content.length, `${name} 的内容不能为空`).toBeGreaterThan(0);
  }
  expect(entries.get('[Content_Types].xml')?.content).toContain('<Types');
  expect(entries.get('xl/workbook.xml')?.content).toContain('<workbook');
  expect(entries.get('xl/worksheets/sheet1.xml')?.content).toContain('<worksheet');
  return entries;
}

describe('sanitizeExportCell', () => {
  it('为公式前缀加单引号', () => {
    expect(sanitizeExportCell('=1+1')).toBe("'=1+1");
    expect(sanitizeExportCell('+123')).toBe("'+123");
    expect(sanitizeExportCell('-foo')).toBe("'-foo");
    expect(sanitizeExportCell('@cmd')).toBe("'@cmd");
  });

  it('普通文本不变', () => {
    expect(sanitizeExportCell('hello')).toBe('hello');
    expect(sanitizeExportCell(null)).toBe('');
  });
});

describe('runExport', () => {
  it('零行导出仍生成含表头且 OOXML 条目完整的工作簿', async () => {
    const { archive, headers } = await exportRows([]);
    const entries = expectValidWorkbookArchive(archive);

    expect(headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(headers.get('content-disposition')).toContain('overtime-records.xlsx');
    const sheetXml = entries.get('xl/worksheets/sheet1.xml')?.content ?? '';
    expect(sheetXml).toContain('员工姓名');
    expect(sheetXml).toContain('加班日期');
    expect(sheetXml).not.toContain('2026-09-04');
  });

  it('有数据时生成完整工作簿并写入数据行', async () => {
    const { archive } = await exportRows([{ employeeName: '测试员工' }]);
    const entries = expectValidWorkbookArchive(archive);
    const sheetXml = entries.get('xl/worksheets/sheet1.xml')?.content ?? '';

    expect(sheetXml).toContain('测试员工');
    expect(sheetXml).toContain('2026-09-04');
  });

  it('报表可设置浅色表头、冻结首行、筛选和列宽', async () => {
    const { archive } = await exportRows([{ employeeName: '测试员工' }], {
      name: '加班记录',
      columnWidths: [18, 14],
      freezeHeader: true,
      autoFilter: true,
      headerFillArgb: 'FFD9EAD3',
    });
    const entries = expectValidWorkbookArchive(archive);
    const sheetXml = entries.get('xl/worksheets/sheet1.xml')?.content ?? '';
    const stylesXml = entries.get('xl/styles.xml')?.content ?? '';

    expect(sheetXml).toContain('<autoFilter');
    expect(sheetXml).toContain('<pane');
    expect(sheetXml).toContain('width="18"');
    expect(entries.get('xl/workbook.xml')?.content).toContain('加班记录');
    expect(stylesXml).toContain('FFD9EAD3');
  });
});
