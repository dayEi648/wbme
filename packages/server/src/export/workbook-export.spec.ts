import { describe, expect, it } from 'vitest';
import { sanitizeExportCell } from './export-cell-sanitize';

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
