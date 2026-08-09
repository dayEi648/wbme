import { Module } from '@nestjs/common';
import { createFileStorage, FileStorageService } from '@wbme/files';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';

/**
 * 平台级文件存储模块（主 PRD §9.2）。
 * 图片预签名上传/正式化/限时下载；OSS 或本地替身由环境决定（createFileStorage）。
 */
@Module({
  controllers: [ImagesController],
  providers: [ImagesService, { provide: FileStorageService, useFactory: async () => createFileStorage() }],
})
export class FilesModule {}
