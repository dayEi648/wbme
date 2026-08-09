import { randomUUID } from 'node:crypto';
import type OSS from 'ali-oss';
import {
  IMAGE_PRESIGN_EXPIRES_SECONDS,
  OSS_PREFIX_BACKUPS,
  OSS_PREFIX_IMAGES,
} from './constants';
import { createOssClient, isOssPlaceholder } from './oss-config';
import { LocalFileStorage } from './local-storage';
import { validateAndReencodeImage } from './image-validation';

/** 预签名上传结果 */
export interface PresignUploadResult {
  objectKey: string;
  uploadUrl: string;
  expiresAt: string;
  /** 开发环境本地直写提示 */
  localPath?: string;
}

/** 图片落库结果 */
export interface FinalizeImageResult {
  objectKey: string;
  mime: string;
  size: number;
}

/** 备份最小清单元数据（backstage PRD §10：清单须含类型/完成时间/库版本/大小/对象标识/SHA-256 校验和） */
export interface BackupManifestMeta {
  /** 备份类型（写入清单；整库恢复后按此补回目录记录） */
  taskType: 'SCHEDULED' | 'IMMEDIATE' | 'EMERGENCY';
  /** 完成时间（ISO 字符串；恢复端回填 backups.backup_time） */
  backupTime: string;
  /** PostgreSQL 版本（回填 backups.pg_version） */
  pgVersion: string | null;
  /** dump.fc 的 SHA-256 校验和（恢复端校验完整性） */
  checksum: string;
}

/**
 * 统一文件存储门面：OSS 或本地替身。
 */
export class FileStorageService {
  private readonly oss: OSS | null;
  private readonly local: LocalFileStorage;

  constructor(env: NodeJS.ProcessEnv = process.env, local?: LocalFileStorage) {
    this.oss = createOssClient(env);
    this.local = local ?? new LocalFileStorage();
  }

  /** 是否使用本地替身 */
  get usesLocalFallback(): boolean {
    return this.oss === null;
  }

  /**
   * 为图片上传生成预签名 PUT URL（客户端直传）。
   *
   * @param userId 上传用户（用于键隔离）
   * @param originalFilename 原始文件名（仅用于扩展名提示）
   */
  async presignImageUpload(userId: number, originalFilename?: string): Promise<PresignUploadResult> {
    const ext = sanitizeExtension(originalFilename);
    const objectKey = `${OSS_PREFIX_IMAGES}${userId}/${randomUUID()}${ext}`;
    return this.presignPut(objectKey, IMAGE_PRESIGN_EXPIRES_SECONDS);
  }

  /**
   * 校验并重编码图片，写入最终对象键（覆盖 pending 键或新键）。
   *
   * @param pendingObjectKey 客户端已上传的临时对象键
   * @param finalObjectKey 可选最终键（缺省沿用 pending）
   */
  async finalizeImage(pendingObjectKey: string, finalObjectKey?: string): Promise<FinalizeImageResult> {
    if (!pendingObjectKey.startsWith(OSS_PREFIX_IMAGES)) {
      throw new Error('图片对象键必须以 images/ 开头');
    }
    const raw = await this.getObjectBytes(pendingObjectKey);
    const { buffer, mime } = await validateAndReencodeImage(raw);
    const targetKey = finalObjectKey ?? pendingObjectKey;
    await this.putObjectBytes(targetKey, buffer, mime);
    if (targetKey !== pendingObjectKey) {
      await this.deleteObject(pendingObjectKey).catch(() => undefined);
    }
    return { objectKey: targetKey, mime, size: buffer.length };
  }

  /**
   * 备份文件服务端上传（Worker 使用 PUT，非浏览器预签名）。
   *
   * 上传成功的同时写入不可变最小清单（backstage PRD §10）：不含凭证或业务内容；
   * 整库恢复后恢复执行器以清单为唯一依据补回被旧快照覆盖的备份目录记录。
   *
   * @param backupId 备份记录 id
   * @param body 备份文件内容
   * @param meta 清单元数据（类型/完成时间/库版本/校验和）
   */
  async presignBackupUpload(
    backupId: number,
    body: Buffer,
    meta: BackupManifestMeta,
  ): Promise<{ objectKey: string; manifestKey: string }> {
    const objectKey = `${OSS_PREFIX_BACKUPS}${backupId}/dump.fc`;
    const manifestKey = `${OSS_PREFIX_BACKUPS}${backupId}/manifest.json`;
    await this.putObjectBytes(objectKey, body, 'application/octet-stream');
    const manifest = JSON.stringify({
      backupId,
      taskType: meta.taskType,
      backupTime: meta.backupTime,
      size: body.length,
      checksum: meta.checksum,
      pgVersion: meta.pgVersion,
      objectKey,
    });
    await this.putObjectBytes(manifestKey, Buffer.from(manifest, 'utf8'), 'application/json');
    return { objectKey, manifestKey };
  }

  /**
   * 读取对象内容（服务端下载；恢复执行器取回备份文件用）。
   *
   * @param objectKey OSS 对象键
   */
  async getObject(objectKey: string): Promise<Buffer> {
    return this.getObjectBytes(objectKey);
  }

  /**
   * 删除对象。
   *
   * @param objectKey OSS 对象键
   */
  async deleteObject(objectKey: string): Promise<void> {
    if (this.oss) {
      await this.oss.delete(objectKey);
      return;
    }
    await this.local.deleteObject(objectKey);
  }

  /**
   * 列出前缀下对象键。
   *
   * @param prefix 键前缀
   */
  async listPrefix(prefix: string): Promise<string[]> {
    return (await this.listPrefixWithMeta(prefix)).map((item) => item.key);
  }

  /**
   * 列出前缀下对象键与最后修改时间（清理任务按保留期判定）。
   *
   * @param prefix 键前缀
   */
  async listPrefixWithMeta(prefix: string): Promise<Array<{ key: string; lastModified: Date | null }>> {
    if (this.oss) {
      // 分页列举（主 PRD §9.2 / backstage PRD §10：对象数 > 1000 时必须续列，
      // 否则清理/孤儿扫描漏扫超出部分）
      const items: Array<{ key: string; lastModified: Date | null }> = [];
      let marker: string | undefined;
      for (;;) {
        const result = await this.oss.list({ prefix, 'max-keys': 1000, marker }, {});
        for (const item of result.objects ?? []) {
          items.push({ key: item.name, lastModified: new Date(item.lastModified) });
        }
        if (!result.nextMarker) {
          break;
        }
        marker = result.nextMarker;
      }
      return items;
    }
    return this.local.listPrefixWithMeta(prefix);
  }

  private async presignPut(objectKey: string, expiresSeconds: number): Promise<PresignUploadResult> {
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000);
    if (this.oss) {
      const uploadUrl = this.oss.signatureUrl(objectKey, {
        method: 'PUT',
        expires: expiresSeconds,
        'Content-Type': 'application/octet-stream',
      });
      return { objectKey, uploadUrl, expiresAt: expiresAt.toISOString() };
    }
    const local = await this.local.presignPut(objectKey, expiresSeconds);
    return {
      objectKey,
      uploadUrl: local.url,
      expiresAt: local.expiresAt.toISOString(),
      localPath: local.url.replace(/^file:\/\//, ''),
    };
  }

  private async getObjectBytes(objectKey: string): Promise<Buffer> {
    if (this.oss) {
      const result = await this.oss.get(objectKey);
      return Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content);
    }
    return this.local.getObject(objectKey);
  }

  private async putObjectBytes(objectKey: string, body: Buffer, contentType: string): Promise<void> {
    if (this.oss) {
      await this.oss.put(objectKey, body, { headers: { 'Content-Type': contentType } });
      return;
    }
    await this.local.putObject(objectKey, body);
  }
}

/** 从文件名提取安全扩展名 */
function sanitizeExtension(filename?: string): string {
  if (!filename) {
    return '.bin';
  }
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(filename);
  if (!match?.[1]) {
    return '.bin';
  }
  return `.${match[1].toLowerCase()}`;
}

/** 工厂：根据环境创建 FileStorageService（local 可注入替身存储，测试隔离用） */
export function createFileStorage(env: NodeJS.ProcessEnv = process.env, local?: LocalFileStorage): FileStorageService {
  return new FileStorageService(env, local);
}

export { isOssPlaceholder, createOssClient };
