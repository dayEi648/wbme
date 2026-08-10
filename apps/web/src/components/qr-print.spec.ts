import { describe, expect, it } from 'vitest';
import { populateQrPrintDocument } from './qr-print';

describe('二维码打印文档', () => {
  it('将二维码名称作为纯文本插入，不解析为 HTML', () => {
    const document = window.document.implementation.createHTMLDocument('二维码打印');
    const label = '<img src=x onerror=alert(1)>';
    const image = populateQrPrintDocument(document, label, 'data:image/png;base64,AA==');

    expect(document.querySelector('h3')?.textContent).toBe(label);
    expect(document.querySelector('h3 img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(image.src).toContain('data:image/png;base64,AA==');
  });
});
