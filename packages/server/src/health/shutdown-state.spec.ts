import { describe, expect, it } from 'vitest';
import { ShutdownStateService } from './shutdown-state';

describe('ShutdownStateService（主 PRD §9.13 优雅停机状态）', () => {
  it('初始不处于停机状态（就绪探针正常）', () => {
    const state = new ShutdownStateService();
    expect(state.isShuttingDown()).toBe(false);
  });

  it('beginShutdown 后立即进入停机状态（就绪探针返回 503）', () => {
    const state = new ShutdownStateService();
    state.beginShutdown();
    expect(state.isShuttingDown()).toBe(true);
  });

  it('重复 beginShutdown 幂等（停机不可逆）', () => {
    const state = new ShutdownStateService();
    state.beginShutdown();
    state.beginShutdown();
    expect(state.isShuttingDown()).toBe(true);
  });
});
