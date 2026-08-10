import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import {
  FileStorageService,
  OSS_PREFIX_IMAGES,
  type FinalizeImageResult,
  type PresignDownloadResult,
  type PresignUploadResult,
} from '@wbme/files';
import { PrismaService } from '../../prisma.service';

/**
 * 平台级图片存储服务（主 PRD §9.2）。
 *
 * - presign：为登录用户签发限时预签名 PUT URL，对象键按用户隔离（images/{userId}/…）；
 * - finalize：服务端校验并重编码临时对象为正式对象，仅限操作人自己的临时对象（防越权）；
 *   成功后登记 backstage.image_objects 正式对象注册表（S-20）；
 * - download：仅放行已登记正式对象（临时对象无下载通道）；限时预签名 GET URL；
 *   备份前缀（backups/）对象禁止经此暴露（主 PRD §9.2「数据库备份不通过普通业务文件下载通道暴露」）。
 *
 * 上传者权限：本服务校验登录身份与对象归属；业务场景功能权限（如资产主图）由
 * 引用该对象的业务保存接口守卫，图片上传本身为平台通用能力。下载放行已登记正式对象
 * （业务记录引用的共享查看场景不误伤；未 finalize 的临时对象一律拒绝，M5）。
 */

/** 服务端生成的图片对象键结构：images/{userId}/{uuid}{ext} */
const IMAGE_OBJECT_KEY_PATTERN = /^images\/\d+\/[0-9a-fA-F-]{36}\.[a-zA-Z0-9]{1,8}$/;

@Injectable()
export class ImagesService {
  constructor(
    private readonly storage: FileStorageService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * 生成图片上传预签名 URL（客户端直传临时对象）。
   *
   * @param userId 上传用户（对象键隔离）
   * @param originalFilename 原始文件名（仅扩展名提示）
   * @returns 预签名 PUT 结果
   */
  presignUpload(userId: number, originalFilename?: string): Promise<PresignUploadResult> {
    return this.storage.presignImageUpload(userId, originalFilename);
  }

  /**
   * 校验并重编码临时对象为正式对象（同键覆盖；临时原对象字节被替换）。
   *
   * @param userId 当前用户
   * @param pendingObjectKey 客户端已上传的临时对象键
   * @returns 正式对象信息（objectKey/mime/size）
   * @throws VALIDATION_FAILED 对象键不属于当前用户或图片格式/体积不合法
   */
  async finalizeUpload(userId: number, pendingObjectKey: string): Promise<FinalizeImageResult> {
    const ownerPrefix = `${OSS_PREFIX_IMAGES}${userId}/`;
    if (!pendingObjectKey.startsWith(ownerPrefix)) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        field: 'pendingObjectKey',
        reason: '对象键不属于当前用户',
      });
    }
    const result = await this.storage.finalizeImage(pendingObjectKey);
    // 登记正式对象注册表（下载仅放行已登记对象；同键重复 finalize 幂等覆盖）
    await this.prisma.client.imageObject.upsert({
      where: { objectKey: result.objectKey },
      create: { objectKey: result.objectKey, ownerUserId: userId },
      update: { ownerUserId: userId },
    });
    return result;
  }

  /**
   * 正式图片对象限时下载 URL（预签名 GET；有效期见 IMAGE_PRESIGN_EXPIRES_SECONDS）。
   *
   * @param objectKey 图片对象键
   * @returns 预签名下载结果
   * @throws VALIDATION_FAILED 对象键结构不合法（非 images/ 前缀或非服务端生成结构）
   * @throws RESOURCE_NOT_FOUND 对象未登记正式化（临时对象无下载通道）
   */
  async downloadUrl(objectKey: string): Promise<PresignDownloadResult> {
    if (!IMAGE_OBJECT_KEY_PATTERN.test(objectKey)) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        field: 'objectKey',
        reason: '对象键结构不合法',
      });
    }
    const registered = await this.prisma.client.imageObject.findUnique({ where: { objectKey } });
    if (!registered) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND, {
        field: 'objectKey',
        reason: '对象未正式化（临时对象不提供下载通道）',
      });
    }
    return this.storage.presignDownload(objectKey);
  }
}
