/**
 * 组件测试环境准备（jsdom）：补齐 antd 组件在 jsdom 下运行所需的环境能力。
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// antd 响应式组件依赖 matchMedia（jsdom 未实现）
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// antd v6 表格/抽屉等组件依赖 ResizeObserver
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'ResizeObserver', { writable: true, value: ResizeObserverMock });

// antd 波点/水波纹依赖 getComputedStyle 与 rAF 动画；测试环境直接放行
window.getComputedStyle = window.getComputedStyle.bind(window);

// 清理测试间残留：显式调用 RTL cleanup 卸载 React 树（执行 effect cleanup、
// 移除 window 监听器）——vitest 未开 globals 时 RTL 的 auto cleanup 不生效，
// 组件会残留到下一个用例（keydown 监听重复注册、findAllByLabelText 命中旧组件）；
// innerHTML 清空仅作防御性兜底（清理不受 React 管理的 portal 等）。
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});
