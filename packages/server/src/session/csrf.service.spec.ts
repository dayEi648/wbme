import { describe, expect, it } from 'vitest';
import { CsrfService } from './csrf.service';

describe('CsrfService（主 PRD §9.7 双提交 Cookie）', () => {
  const csrf = new CsrfService('test-signing-key-at-least-32-chars-long!!');

  it('签名密钥长度不足拒绝实例化（部署级机密约束）', () => {
    expect(() => new CsrfService('short')).toThrow(/COOKIE_SIGNING_KEY/);
  });

  it('签发与校验通过（头 === Cookie 且签名有效）', () => {
    const token = csrf.issue();
    expect(csrf.verify(token, token)).toBe(true);
  });

  it('头与 Cookie 不一致（双提交失败）拒绝', () => {
    const token = csrf.issue();
    expect(csrf.verify(token, 'attacker-forged-value')).toBe(false);
  });

  it('篡改 nonce 或签名拒绝', () => {
    const token = csrf.issue();
    const dot = token.lastIndexOf('.');
    const tamperedNonce = `tampered${token.slice(9)}`;
    expect(csrf.verify(tamperedNonce, tamperedNonce)).toBe(false);
    const tamperedSig = `${token.slice(0, dot)}.AAAA`;
    expect(csrf.verify(tamperedSig, tamperedSig)).toBe(false);
  });

  it('缺失值/过短值拒绝', () => {
    expect(csrf.verify(undefined, undefined)).toBe(false);
    expect(csrf.verify('', '')).toBe(false);
    expect(csrf.verify('short', 'short')).toBe(false);
  });

  it('不同签发互不通过（nonce 随机性）', () => {
    const a = csrf.issue();
    const b = csrf.issue();
    expect(a).not.toBe(b);
    expect(csrf.verify(a, b)).toBe(false);
  });
});
