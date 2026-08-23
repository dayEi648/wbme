import { describe, expect, it } from 'vitest';
import {
  PLATFORM_SESSION_IDLE_TIMEOUT_KEYS,
  createPlatformSessionIdleTimeoutProvider,
} from './platform-idle-timeout';

describe('跨系统会话空闲超时提供者', () => {
  it('按“记住我”状态读取对应的平台设置，并将秒转换为毫秒', async () => {
    const requestedKeys: string[] = [];
    const provider = createPlatformSessionIdleTimeoutProvider(async (key) => {
      requestedKeys.push(key);
      return key === PLATFORM_SESSION_IDLE_TIMEOUT_KEYS.REMEMBER_ME ? '7200' : '1800';
    });

    await expect(provider(false)).resolves.toBe(1_800_000);
    await expect(provider(true)).resolves.toBe(7_200_000);
    expect(requestedKeys).toEqual([
      PLATFORM_SESSION_IDLE_TIMEOUT_KEYS.DEFAULT,
      PLATFORM_SESSION_IDLE_TIMEOUT_KEYS.REMEMBER_ME,
    ]);
  });

  it('短缓存复用最近的有效值，避免每次有效交互都查询平台设置', async () => {
    let calls = 0;
    const provider = createPlatformSessionIdleTimeoutProvider(async () => {
      calls += 1;
      return '120';
    });

    await expect(provider(false)).resolves.toBe(120_000);
    await expect(provider(false)).resolves.toBe(120_000);
    expect(calls).toBe(1);
  });

  it('缺失或无效配置时使用安全的默认空闲超时', async () => {
    const provider = createPlatformSessionIdleTimeoutProvider(async () => '59');

    await expect(provider(false)).resolves.toBe(86_400_000);
  });
});
