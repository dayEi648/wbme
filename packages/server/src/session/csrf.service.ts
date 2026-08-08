import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CSRF 双提交 Cookie 服务（主 PRD §9.7）。
 *
 * Cookie 值 = `nonce.HMAC-SHA256(COOKIE_SIGNING_KEY, nonce)`（base64url）。
 * 守卫要求：状态变更请求的自定义头 X-WBME-CSRF-Token 与 Cookie 值一致且签名有效。
 * 签名密钥为部署级机密（环境变量 COOKIE_SIGNING_KEY 注入），不进入代码与日志。
 */
export class CsrfService {
  /** Cookie 值最小长度：nonce(32B base64url) + '.' + sig(43B) */
  static readonly MIN_TOKEN_LENGTH = 76;

  private readonly key: Buffer;

  constructor(signingKey: string) {
    if (!signingKey || signingKey.length < 32) {
      throw new Error('COOKIE_SIGNING_KEY 未配置或长度不足 32（主 PRD §9.7 CSRF 签名密钥）');
    }
    this.key = Buffer.from(signingKey);
  }

  /** 签发新 CSRF Cookie 值 */
  issue(): string {
    const nonce = randomBytes(32).toString('base64url');
    return `${nonce}.${this.sign(nonce)}`;
  }

  /**
   * 校验双提交：自定义头与 Cookie 一致且签名有效。
   * @param cookieValue wbme_csrf Cookie 值
   * @param headerValue X-WBME-CSRF-Token 请求头值
   */
  verify(cookieValue: string | undefined, headerValue: string | undefined): boolean {
    if (!cookieValue || !headerValue || cookieValue.length < CsrfService.MIN_TOKEN_LENGTH) {
      return false;
    }
    // 双提交：头必须与 Cookie 完全相同（浏览器无法为第三方域读取或写入本域 Cookie）
    if (cookieValue !== headerValue) {
      return false;
    }
    const dot = cookieValue.lastIndexOf('.');
    if (dot <= 0) {
      return false;
    }
    const nonce = cookieValue.slice(0, dot);
    const expected = this.sign(nonce);
    const provided = cookieValue.slice(dot + 1);
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private sign(nonce: string): string {
    return createHmac('sha256', this.key).update(nonce).digest('base64url');
  }
}
