import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
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

/** 预签名下载结果 */
export interface PresignDownloadResult {
  objectKey: string;
  downloadUrl: string;
  expiresAt: string;
  /** 开发环境本地直读提示 */
  localPath?: string;
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

  constructor(oss: OSS | null, local?: LocalFileStorage) {
    this.oss = oss;
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
   * 为正式图片对象生成限时预签名 GET URL（主 PRD §9.2：私有正式对象限时下载）。
   * 临时原对象（未 finalize）与备份前缀（backups/）对象不得经此通道暴露。
   *
   * @param objectKey 图片对象键（images/ 前缀）
   * @param expiresSeconds 有效期秒数（缺省 IMAGE_PRESIGN_EXPIRES_SECONDS）
   */
  async presignDownload(
    objectKey: string,
    expiresSeconds: number = IMAGE_PRESIGN_EXPIRES_SECONDS,
  ): Promise<PresignDownloadResult> {
    if (!objectKey.startsWith(OSS_PREFIX_IMAGES)) {
      throw new Error('图片对象键必须以 images/ 开头');
    }
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000);
    if (this.oss) {
      const downloadUrl = this.oss.signatureUrl(objectKey, {
        method: 'GET',
        expires: expiresSeconds,
      });
      return { objectKey, downloadUrl, expiresAt: expiresAt.toISOString() };
    }
    const local = await this.local.presignGet(objectKey, expiresSeconds);
    return {
      objectKey,
      downloadUrl: local.url,
      expiresAt: local.expiresAt.toISOString(),
      localPath: local.url.replace(/^file:\/\//, ''),
    };
  }

  /**
   * 备份文件服务端流式上传（Worker 使用 PUT，非浏览器预签名；问题16 修复）。
   *
   * 大备份不整体读入内存（worker 256m 上限内防 OOM）：流式上传同时计算 SHA-256，
   * 上传成功后写入不可变最小清单（backstage PRD §10）：不含凭证或业务内容；
   * 整库恢复后恢复执行器以清单为唯一依据补回被旧快照覆盖的备份目录记录。
   *
   * @param backupId 备份记录 id
   * @param stream 备份文件内容流（如 pg_dump 输出文件读取流）
   * @param meta 清单元数据（类型/完成时间/库版本/大小；校验和由本方法流式计算返回）
   */
  async presignBackupUpload(
    backupId: number,
    stream: NodeJS.ReadableStream,
    meta: Omit<BackupManifestMeta, 'checksum'> & { size: number },
  ): Promise<{ objectKey: string; manifestKey: string; checksum: string }> {
    const objectKey = `${OSS_PREFIX_BACKUPS}${backupId}/dump.fc`;
    const manifestKey = `${OSS_PREFIX_BACKUPS}${backupId}/manifest.json`;
    // 流式上传与 SHA-256 并行：显式泵把源流逐块扇出到 hash 与 tee（上传消费者）。
    // 不用 tee.pipe 多路分流：pipe 会让 tee 进入 flowing 模式，晚挂接的消费者丢失已流出
    // 的块（本地替身 putObjectStream 内部先 await mkdir 才挂接消费，存在该竞态）；
    // PassThrough 在消费者挂接前缓冲写入，write 返回值提供背压（按最慢消费者暂停源流）。
    //
    // 失败路径（批次8复核修复）：任一环节失败都显式销毁 tee 并让所有等待方 reject——
    // - 上传中途失败：就地 catch 销毁 tee（ali-oss 不保证销毁输入流），泵内 drain 等待
    //   立即 reject 退出；就地挂接 catch 避免 await 前 reject 造成 unhandled rejection；
    // - 源流错误：for-await 抛出，catch 销毁 tee 把错误传播给上传消费方；
    // - tee 的 'error' 常驻吸收监听：泵正等待源流数据时上传失败销毁 tee 不致 uncaught。
    const hash = createHash('sha256');
    const tee = new PassThrough();
    const uploadPromise = this.putObjectStream(objectKey, tee, 'application/octet-stream');
    // 上传中途失败：就地 catch 销毁 tee，泵内 drain 等待立即 reject 退出（ali-oss 不保证
    // 销毁输入流）；就地挂接 catch 避免 await 前 reject 造成 unhandled rejection；
    // uploadError 保留原始失败原因，泵退出时优先抛出（drain 等待可能只拿到销毁错误）
    let uploadError: Error | null = null;
    uploadPromise.catch((error: unknown) => {
      uploadError = error instanceof Error ? error : new Error(String(error));
      tee.destroy(uploadError);
    });
    tee.on('error', () => undefined);
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        hash.update(chunk);
        if (!tee.write(chunk)) {
          // 背压：等待 tee 排空；tee 被销毁（上传失败）时 once 以该错误 reject，泵随之退出
          await once(tee, 'drain');
        }
      }
    } catch (error) {
      const failure = uploadError ?? (error instanceof Error ? error : new Error(String(error)));
      tee.destroy(failure);
      throw failure;
    }
    tee.end();
    const checksum = hash.digest('hex');
    // 上传成功才写清单（backstage PRD §10 语义不变）
    await uploadPromise;
    const manifest = JSON.stringify({
      backupId,
      taskType: meta.taskType,
      backupTime: meta.backupTime,
      size: meta.size,
      checksum,
      pgVersion: meta.pgVersion,
      objectKey,
    });
    await this.putObjectBytes(manifestKey, Buffer.from(manifest, 'utf8'), 'application/json');
    return { objectKey, manifestKey, checksum };
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
   * 读取对象元数据（恢复预检验证服务端加密用，问题6 修复）。
   *
   * OSS 对象级 SSE（写入时携带 x-oss-server-side-encryption）会经 HEAD 响应头回显；
   * 本地替身无加密概念，返回空元数据（调用方跳过验证）。
   *
   * @param objectKey OSS 对象键
   * @returns 服务端加密方式（无元数据时为空）
   */
  async headObject(objectKey: string): Promise<{ serverSideEncryption?: string }> {
    if (this.oss) {
      const result = await this.oss.head(objectKey);
      const headers = (result.res?.headers ?? {}) as Record<string, unknown>;
      const encryption = headers['x-oss-server-side-encryption'];
      return {
        serverSideEncryption: typeof encryption === 'string' ? encryption : undefined,
      };
    }
    return {};
  }

  /**
   * 流式上传对象（问题16 修复：大备份不整体读入内存）。
   *
   * @param objectKey OSS 对象键
   * @param stream 内容流
   * @param contentType 内容类型
   */
  async putObjectStream(objectKey: string, stream: NodeJS.ReadableStream, contentType: string): Promise<void> {
    if (this.oss) {
      // ali-oss putStream 以 mime 选项声明内容类型；SSE-OSS/AES256 对象级加密经 headers 携带。
      // @types/ali-oss 的 PutStreamOptions 把 timeout/meta/callback 误标必填，实际运行均可选，断言绕过
      await this.oss.putStream(objectKey, stream as Readable, {
        mime: contentType,
        headers: {
          'x-oss-server-side-encryption': 'AES256',
        },
      } as never);
      return;
    }
    await this.local.putObjectStream(objectKey, stream);
  }

  /**
   * 流式下载对象（问题16 修复：恢复取回备份流式写盘，不整体读入内存）。
   *
   * @param objectKey OSS 对象键
   * @returns 内容流（支持 async iteration 背压）
   */
  async getObjectStream(objectKey: string): Promise<NodeJS.ReadableStream> {
    if (this.oss) {
      const result = await this.oss.getStream(objectKey);
      return result.stream as unknown as NodeJS.ReadableStream;
    }
    return this.local.getObjectStream(objectKey);
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
      // 对象级服务端加密（主 PRD §9.2 第 265 行）：统一携带 SSE-OSS/AES256，
      // 备份写入时必带、恢复预检按此头验证；图片对象同样受对象级加密保护
      await this.oss.put(objectKey, body, {
        headers: {
          'Content-Type': contentType,
          'x-oss-server-side-encryption': 'AES256',
        },
      });
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
export async function createFileStorage(
  env: NodeJS.ProcessEnv = process.env,
  local?: LocalFileStorage,
): Promise<FileStorageService> {
  const oss = await createOssClient(env);
  return new FileStorageService(oss, local);
}

export { isOssPlaceholder, createOssClient };
