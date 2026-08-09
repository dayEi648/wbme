import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { FinalizeImageResult, PresignDownloadResult, PresignUploadResult } from '@wbme/files';
import { CurrentUser } from '@wbme/server';
import { DownloadImageQuery, FinalizeImageDto, PresignImageDto } from './images.dto';
import { ImagesService } from './images.service';

/**
 * 平台级图片上传与下载 API（主 PRD §9.2）。
 * 仅需登录；业务关联时的功能权限由引用图片的业务保存接口校验。
 */
@ApiTags('文件存储')
@Controller('files/images')
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Post('presign')
  @ApiOperation({ summary: '生成图片上传预签名 URL（客户端直传临时对象）' })
  presignUpload(@CurrentUser() userId: number, @Body() dto: PresignImageDto): Promise<PresignUploadResult> {
    return this.images.presignUpload(userId, dto.originalFilename);
  }

  @Post('finalize')
  @ApiOperation({ summary: '校验并重编码图片为正式对象（仅限本人临时对象）' })
  finalizeUpload(@CurrentUser() userId: number, @Body() dto: FinalizeImageDto): Promise<FinalizeImageResult> {
    return this.images.finalizeUpload(userId, dto.pendingObjectKey);
  }

  @Get('download')
  @ApiOperation({ summary: '正式图片对象限时下载 URL（预签名 GET）' })
  downloadUrl(@Query() query: DownloadImageQuery): Promise<PresignDownloadResult> {
    return this.images.downloadUrl(query.objectKey);
  }
}
