/**
 * @wbme/files：统一文件存储（OSS 预签名、图片校验重编码、本地开发替身）。
 */

export * from './constants';
export * from './oss-config';
export * from './local-storage';
export * from './image-validation';
export * from './file-storage';

import { createFileStorage, FileStorageService } from './file-storage';

/** 默认存储单例（按进程环境） */
let defaultStorage: FileStorageService | undefined;

function storage(): FileStorageService {
  if (!defaultStorage) {
    defaultStorage = createFileStorage();
  }
  return defaultStorage;
}

/** @see FileStorageService.presignImageUpload */
export const presignImageUpload = (...args: Parameters<FileStorageService['presignImageUpload']>) =>
  storage().presignImageUpload(...args);

/** @see FileStorageService.finalizeImage */
export const finalizeImage = (...args: Parameters<FileStorageService['finalizeImage']>) =>
  storage().finalizeImage(...args);

/** @see FileStorageService.presignBackupUpload */
export const presignBackupUpload = (...args: Parameters<FileStorageService['presignBackupUpload']>) =>
  storage().presignBackupUpload(...args);

/** @see FileStorageService.deleteObject */
export const deleteObject = (...args: Parameters<FileStorageService['deleteObject']>) => storage().deleteObject(...args);

/** @see FileStorageService.listPrefix */
export const listPrefix = (...args: Parameters<FileStorageService['listPrefix']>) => storage().listPrefix(...args);
