import { describe, expect, it } from 'vitest';
import { detectImageFormat, validateAndReencodeImage } from './image-validation';

/** 最小合法 PNG（1x1 透明） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('detectImageFormat', () => {
  it('识别 PNG', () => {
    expect(detectImageFormat(TINY_PNG)).toBe('png');
  });

  it('拒绝 GIF magic', () => {
    const gif = Buffer.from('GIF89a', 'ascii');
    expect(() => detectImageFormat(gif)).toThrow();
  });
});

describe('validateAndReencodeImage', () => {
  it('重编码 PNG 并返回 buffer', async () => {
    const result = await validateAndReencodeImage(TINY_PNG);
    expect(result.mime).toBe('image/png');
    expect(result.buffer.length).toBeGreaterThan(0);
  });
});
