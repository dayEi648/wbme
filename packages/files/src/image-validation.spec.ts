import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { detectImageFormat, validateAndReencodeImage } from './image-validation';
import { IMAGE_MAX_DIMENSION } from './constants';

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

  it('拒绝单边超过像素上限的图片（防解压炸弹）', async () => {
    // 构造 (上限+1)x1 纯色 PNG：字节极小但 metadata 单边超限
    const wide = await sharp({
      create: { width: IMAGE_MAX_DIMENSION + 1, height: 1, channels: 3, background: 'black' },
    })
      .png()
      .toBuffer();
    // VALIDATION_FAILED 固定文案「请求参数不合法」（reason 经 detailsFields 白名单过滤）
    await expect(validateAndReencodeImage(wide)).rejects.toThrow('请求参数不合法');
  });
});
