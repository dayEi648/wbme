import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { LOCAL_OSS_ROOT } from './constants';

/**
 * 本地文件存储替身（开发环境 OSS 凭证为 change-me 时使用）。
 * 将对象键映射到 `.agents/tmp-oss/` 下的相对路径。
 */
export class LocalFileStorage {
  private readonly root: string;

  /**
   * @param rootDir 根目录（默认仓库根下 LOCAL_OSS_ROOT）
   */
  constructor(rootDir?: string) {
    this.root = resolve(rootDir ?? process.cwd(), LOCAL_OSS_ROOT);
  }

  /** 对象键对应的绝对路径 */
  private resolvePath(objectKey: string): string {
    const normalized = objectKey.replace(/^\/+/, '');
    return join(this.root, normalized);
  }

  /**
   * 写入对象。
   *
   * @param objectKey OSS 对象键
   * @param body 文件内容
   */
  async putObject(objectKey: string, body: Buffer): Promise<void> {
    const filePath = this.resolvePath(objectKey);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
  }

  /**
   * 读取对象。
   *
   * @param objectKey OSS 对象键
   * @returns 文件内容
   * @throws 文件不存在时由 fs 抛出
   */
  async getObject(objectKey: string): Promise<Buffer> {
    return readFile(this.resolvePath(objectKey));
  }

  /**
   * 流式写入对象（问题16 修复：大备份不整体读入内存）。
   *
   * @param objectKey OSS 对象键
   * @param stream 内容流
   */
  async putObjectStream(objectKey: string, stream: NodeJS.ReadableStream): Promise<void> {
    const filePath = this.resolvePath(objectKey);
    await mkdir(dirname(filePath), { recursive: true });
    await pipeline(stream as NodeJS.ReadableStream, createWriteStream(filePath));
  }

  /**
   * 流式读取对象（问题16 修复：恢复取回备份流式写盘）。
   *
   * @param objectKey OSS 对象键
   * @returns 文件读取流
   */
  async getObjectStream(objectKey: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(this.resolvePath(objectKey));
  }

  /**
   * 删除对象。
   *
   * @param objectKey OSS 对象键
   */
  async deleteObject(objectKey: string): Promise<void> {
    await rm(this.resolvePath(objectKey), { force: true });
  }

  /**
   * 列出前缀下的对象键。
   *
   * @param prefix 键前缀（如 images/）
   * @returns 对象键列表（相对 OSS 键）
   */
  async listPrefix(prefix: string): Promise<string[]> {
    return (await this.listPrefixWithMeta(prefix)).map((item) => item.key);
  }

  /** 列出前缀下对象键与最后修改时间（本地用文件 mtime） */
  async listPrefixWithMeta(prefix: string): Promise<Array<{ key: string; lastModified: Date | null }>> {
    const dir = this.resolvePath(prefix);
    try {
      const entries = await readdir(dir, { withFileTypes: true, recursive: true });
      const keys: Array<{ key: string; lastModified: Date | null }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const parent = entry.parentPath ?? dir;
        const rel = parent.slice(this.root.length + 1);
        const key = `${rel}/${entry.name}`.replace(/\\/g, '/');
        if (!key.startsWith(prefix)) {
          continue;
        }
        let lastModified: Date | null = null;
        try {
          lastModified = (await stat(join(parent, entry.name))).mtime;
        } catch {
          // 文件被并发删除等竞态：时间未知按可删处理（键仍返回，由清理方按保留期判定）
        }
        keys.push({ key, lastModified });
      }
      return keys;
    } catch {
      return [];
    }
  }

  /**
   * 生成本地「预签名 PUT」URL（开发用 file:// 路径提示）。
   *
   * @param objectKey 对象键
   * @param expiresSeconds 有效期（仅写入元数据）
   */
  async presignPut(objectKey: string, expiresSeconds: number): Promise<{ url: string; expiresAt: Date }> {
    const filePath = this.resolvePath(objectKey);
    await mkdir(dirname(filePath), { recursive: true });
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000);
    return { url: `file://${filePath}`, expiresAt };
  }

  /**
   * 生成本地「预签名 GET」URL。
   *
   * @param objectKey 对象键
   * @param expiresSeconds 有效期
   */
  async presignGet(objectKey: string, expiresSeconds: number): Promise<{ url: string; expiresAt: Date }> {
    const filePath = this.resolvePath(objectKey);
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000);
    return { url: `file://${filePath}`, expiresAt };
  }

  /**
   * 获取对象大小（字节）。
   *
   * @param objectKey 对象键
   */
  async headObjectSize(objectKey: string): Promise<number> {
    const info = await stat(this.resolvePath(objectKey));
    return info.size;
  }
}
