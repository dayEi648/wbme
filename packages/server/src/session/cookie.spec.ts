import { describe, expect, it } from 'vitest';
import { csrfCookieOptions, flowCookieOptions, sessionCookieOptions } from './cookie';

describe('Cookie 属性（主 PRD §9.7、base PRD §7.3）', () => {
  it('会话 Cookie：HttpOnly + SameSite=Lax + Path=/；记住我时带 maxAge（服务端绝对过期），否则浏览器会话级', () => {
    const withRemember = sessionCookieOptions(true, 7776000);
    expect(withRemember.httpOnly).toBe(true);
    expect(withRemember.secure).toBe(true);
    expect(withRemember.sameSite).toBe('lax');
    expect(withRemember.path).toBe('/');
    expect(withRemember.maxAge).toBe(7776000 * 1000);

    const withoutRemember = sessionCookieOptions(false);
    expect(withoutRemember.maxAge).toBeUndefined();
  });

  it('CSRF Cookie：非 HttpOnly（前端可读）；记住我登录时与会话 Cookie 同 maxAge，否则浏览器会话级', () => {
    const withRemember = csrfCookieOptions(true, 7776000);
    expect(withRemember.httpOnly).toBe(false);
    expect(withRemember.secure).toBe(true);
    expect(withRemember.sameSite).toBe('lax');
    expect(withRemember.maxAge).toBe(7776000 * 1000);

    const withoutRemember = csrfCookieOptions(false);
    expect(withoutRemember.maxAge).toBeUndefined();
  });

  it('流程 Cookie：HttpOnly + Path 覆盖 /api/v1/auth', () => {
    const flow = flowCookieOptions(false);
    expect(flow.httpOnly).toBe(true);
    expect(flow.path).toBe('/api/v1/auth');
  });
});
