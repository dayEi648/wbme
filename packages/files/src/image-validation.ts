import { BusinessException, frameworkErrors } from '@wbme/contracts';
import sharp from 'sharp';
import { IMAGE_MAX_BYTES } from './constants';

/** 允许的栅格图片 MIME */
export const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * 根据 magic bytes 检测图片格式；拒绝 SVG/GIF 及未知格式。
 *
 * @param buffer 文件头若干字节即可
 * @returns 检测到的格式
 * @throws BusinessException VALIDATION_FAILED
 */
export function detectImageFormat(buffer: Buffer): 'jpeg' | 'png' | 'webp' {
  if (buffer.length < 12) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { field: 'file', reason: '文件过短' });
  }
  const head = buffer.subarray(0, 12);
  const ascii = head.toString('utf8', 0, Math.min(12, head.length)).toLowerCase();
  if (ascii.startsWith('<?xml') || ascii.startsWith('<svg') || ascii.includes('<svg')) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { field: 'file', reason: '不允许 SVG' });
  }
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'jpeg';
  }
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a') {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { field: 'file', reason: '不允许 GIF' });
  }
  throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { field: 'file', reason: '仅支持 JPEG/PNG/WebP' });
}

/**
 * 校验图片体积并重编码（剥离 EXIF）。
 *
 * @param input 原始图片字节
 * @returns 重编码后的字节与 MIME
 * @throws BusinessException 格式或体积不合法
 */
export async function validateAndReencodeImage(input: Buffer): Promise<{ buffer: Buffer; mime: string; format: 'jpeg' | 'png' | 'webp' }> {
  if (input.length > IMAGE_MAX_BYTES) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
      field: 'file',
      reason: `图片超过 ${IMAGE_MAX_BYTES} 字节上限`,
    });
  }
  const format = detectImageFormat(input);
  const pipeline = sharp(input, { failOn: 'error' }).rotate();
  let output: Buffer;
  let mime: string;
  if (format === 'jpeg') {
    output = await pipeline.jpeg({ mozjpeg: true }).toBuffer();
    mime = 'image/jpeg';
  } else if (format === 'png') {
    output = await pipeline.png().toBuffer();
    mime = 'image/png';
  } else {
    output = await pipeline.webp().toBuffer();
    mime = 'image/webp';
  }
  if (output.length > IMAGE_MAX_BYTES) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
      field: 'file',
      reason: '重编码后仍超过体积上限',
    });
  }
  return { buffer: output, mime, format };
}
