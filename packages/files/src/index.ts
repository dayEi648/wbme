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
let defaultStoragePromise: Promise<FileStorageService> | undefined;

async function getDefaultStorage(): Promise<FileStorageService> {
  if (defaultStorage) {
    return defaultStorage;
  }
  if (!defaultStoragePromise) {
    defaultStoragePromise = createFileStorage().then((storage) => {
      defaultStorage = storage;
      return storage;
    });
  }
  return defaultStoragePromise;
}

/** @see FileStorageService.presignImageUpload */
export const presignImageUpload = async (...args: Parameters<FileStorageService['presignImageUpload']>) =>
  (await getDefaultStorage()).presignImageUpload(...args);

/** @see FileStorageService.finalizeImage */
export const finalizeImage = async (...args: Parameters<FileStorageService['finalizeImage']>) =>
  (await getDefaultStorage()).finalizeImage(...args);

/** @see FileStorageService.presignBackupUpload */
export const presignBackupUpload = async (...args: Parameters<FileStorageService['presignBackupUpload']>) =>
  (await getDefaultStorage()).presignBackupUpload(...args);

/** @see FileStorageService.deleteObject */
export const deleteObject = async (...args: Parameters<FileStorageService['deleteObject']>) =>
  (await getDefaultStorage()).deleteObject(...args);

/** @see FileStorageService.listPrefix */
export const listPrefix = async (...args: Parameters<FileStorageService['listPrefix']>) =>
  (await getDefaultStorage()).listPrefix(...args);
