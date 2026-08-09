import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * 平台密码服务（base PRD §2、主 PRD §9.7）。
 *
 * - Argon2id 加盐哈希、不可逆存储（@node-rs/argon2 预编译二进制）；
 * - 平台密码只校验 8~32 个字符，不要求大小写/数字/符号组合；
 * - 密码只校验格式，不在业务代码中硬编码强度规则。
 */

/** 密码最短长度（base PRD §2） */
export const PASSWORD_MIN_LENGTH = 8;
/** 密码最长长度 */
export const PASSWORD_MAX_LENGTH = 32;

@Injectable()
export class PasswordService {
  /** 校验密码策略：8~32 个字符 */
  validatePolicy(password: string): boolean {
    return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
  }

  /** Argon2id 哈希（每次生成新盐） */
  async hash(password: string): Promise<string> {
    return hash(password, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  }

  /** 校验密码与哈希 */
  async verifyPassword(password: string, passwordHash: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      // 哈希格式异常按校验失败处理，不泄露内部细节
      return false;
    }
  }
}
