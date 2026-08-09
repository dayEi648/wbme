import { BusinessException, frameworkErrors } from '@wbme/contracts';
import type { FileStorageService } from '@wbme/files';
import { describe, expect, it, vi } from 'vitest';
import { ImagesService } from './images.service';

/** 服务端生成键形状的样例（images/{userId}/{uuid}{ext}） */
const SAMPLE_KEY = 'images/42/9f4f4f18-0c2e-4c1b-9f3f-7f6a5e4d3c2b.png';

function createService(storage?: Partial<FileStorageService>): { service: ImagesService; storage: Partial<FileStorageService> } {
  const fake = storage ?? { presignImageUpload: vi.fn(), finalizeImage: vi.fn(), presignDownload: vi.fn() };
  return { service: new ImagesService(fake as unknown as FileStorageService), storage: fake };
}

describe('ImagesService', () => {
  describe('presignUpload', () => {
    it('透传 storage.presignImageUpload 并携带用户 id', async () => {
      const { service, storage } = createService();
      const expected = { objectKey: SAMPLE_KEY, uploadUrl: 'https://oss.example.com/put', expiresAt: '2026-01-01T00:00:00Z' };
      vi.mocked(storage.presignImageUpload!).mockResolvedValue(expected);

      const result = await service.presignUpload(42, '照片.png');

      expect(storage.presignImageUpload).toHaveBeenCalledWith(42, '照片.png');
      expect(result).toEqual(expected);
    });

    it('未传文件名时仅传用户 id', async () => {
      const { service, storage } = createService();
      await service.presignUpload(7);
      expect(storage.presignImageUpload).toHaveBeenCalledWith(7, undefined);
    });
  });

  describe('finalizeUpload', () => {
    it('本人键前缀：调用 finalizeImage 并返回正式对象信息', async () => {
      const { service, storage } = createService();
      const expected = { objectKey: SAMPLE_KEY, mime: 'image/png', size: 1024 };
      vi.mocked(storage.finalizeImage!).mockResolvedValue(expected);

      const result = await service.finalizeUpload(42, SAMPLE_KEY);

      expect(storage.finalizeImage).toHaveBeenCalledWith(SAMPLE_KEY);
      expect(result).toEqual(expected);
    });

    it('他人键前缀：抛 VALIDATION_FAILED 且不触达存储', async () => {
      const { service, storage } = createService();
      await expect(service.finalizeUpload(42, 'images/999/9f4f4f18-0c2e-4c1b-9f3f-7f6a5e4d3c2b.png')).rejects.toThrow(
        new BusinessException(frameworkErrors.VALIDATION_FAILED),
      );
      expect(storage.finalizeImage).not.toHaveBeenCalled();
    });

    it('非 images/ 前缀（如 backups/）：抛 VALIDATION_FAILED', async () => {
      const { service, storage } = createService();
      await expect(service.finalizeUpload(42, 'backups/1/dump.fc')).rejects.toThrow(
        new BusinessException(frameworkErrors.VALIDATION_FAILED),
      );
      expect(storage.finalizeImage).not.toHaveBeenCalled();
    });
  });

  describe('downloadUrl', () => {
    it('合法正式键：返回预签名下载结果', async () => {
      const { service, storage } = createService();
      const expected = { objectKey: SAMPLE_KEY, downloadUrl: 'https://oss.example.com/get', expiresAt: '2026-01-01T00:00:00Z' };
      vi.mocked(storage.presignDownload!).mockResolvedValue(expected);

      const result = await service.downloadUrl(SAMPLE_KEY);

      expect(storage.presignDownload).toHaveBeenCalledWith(SAMPLE_KEY);
      expect(result).toEqual(expected);
    });

    it.each([
      'backups/42/x.png',
      'images/42/not-a-uuid.png',
      'images/42/9f4f4f18-0c2e-4c1b-9f3f-7f6a5e4d3c2b',
      'images/42/9f4f4f18-0c2e-4c1b-9f3f-7f6a5e4d3c2b.png/extra',
      '../images/42/9f4f4f18-0c2e-4c1b-9f3f-7f6a5e4d3c2b.png',
    ])('结构非法键（%s）：抛 VALIDATION_FAILED 且不触达存储', async (objectKey) => {
      const { service, storage } = createService();
      await expect(service.downloadUrl(objectKey)).rejects.toThrow(new BusinessException(frameworkErrors.VALIDATION_FAILED));
      expect(storage.presignDownload).not.toHaveBeenCalled();
    });
  });
});
