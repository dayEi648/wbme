import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

/**
 * 一次性凭证服务（base PRD §2）。
 *
 * - 凭证 = 密码学安全随机值（256bit），数据库只保存 SHA-256 摘要；
 * - 邀请/重置/换绑凭证统一经此生成与摘要；
 * - 凭证原文不得进入访问日志、操作日志、前端持久存储或错误详情。
 */
@Injectable()
export class TokenService {
  /** 生成新凭证（base64url，32 字节 = 256bit 熵） */
  generate(): string {
    return randomBytes(32).toString('base64url');
  }

  /** 凭证摘要（SHA-256，数据库存储形态） */
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
