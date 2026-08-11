import { BusinessException, frameworkErrors } from '@wbme/contracts';
import sharp from 'sharp';
import { IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION, IMAGE_MAX_TOTAL_PIXELS } from './constants';

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
  // 像素尺寸/总像素上限：防解压炸弹（1MB 压缩可解压成上亿像素，sharp 解码时 OOM）
  await assertImageDimensions(input);
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

/**
 * 校验图片像素尺寸与总像素上限（防解压炸弹）。
 *
 * sharp.metadata() 只读图片头解析尺寸、不解码全图，是廉价且正确的拦截点；
 * 解析失败时不抛错（交由后续 toBuffer 解码失败处理），仅对成功解析的尺寸做上限校验。
 *
 * @param input 原始图片字节
 * @throws BusinessException VALIDATION_FAILED 单边或总像素超上限
 */
async function assertImageDimensions(input: Buffer): Promise<void> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input).metadata();
  } catch {
    return;
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    return;
  }
  if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
      field: 'file',
      reason: `图片单边超过 ${IMAGE_MAX_DIMENSION}px 上限`,
    });
  }
  if (width * height > IMAGE_MAX_TOTAL_PIXELS) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
      field: 'file',
      reason: `图片总像素超过 ${IMAGE_MAX_TOTAL_PIXELS} 上限`,
    });
  }
}
