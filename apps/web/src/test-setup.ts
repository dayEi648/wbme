/**
 * 组件测试环境准备（jsdom）：补齐 antd 组件在 jsdom 下运行所需的环境能力。
 */
import { afterEach } from 'vitest';

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

// 清理测试间残留（每个测试文件内由 testing-library 的 auto cleanup 处理，
// 此处仅为防御性清空 DOM）
afterEach(() => {
  document.body.innerHTML = '';
});
