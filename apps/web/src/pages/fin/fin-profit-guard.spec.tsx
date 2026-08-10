import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfitAnalysis } from './FinPage';

/**
 * M22 复核修复回归：离开保护（fin PRD §4）。
 * 原修复用 useBlocker——声明式 <BrowserRouter> 下必然抛错致整页白屏；
 * 现实现为 location 变化检测 + Modal 确认 + 回退防重入。
 * 用例：有草稿时导航弹确认；「留在本页」回退且不重复弹窗；
 * 「放弃并离开」放行；无草稿不拦截。
 *
 * antd Modal 的关闭动画依赖 transitionend，jsdom 下永不触发导致 DOM 卡在
 * 离开动画态——将 Modal mock 为条件渲染组件（open 即渲染、关闭即移除）。
 */
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    Modal: ({ open, onOk, onCancel, children }: { open?: boolean; onOk?: () => void; onCancel?: () => void; children?: React.ReactNode }) =>
      open ? (
        <div data-testid="leave-modal">
          <p>未保存的编辑内容</p>
          <button onClick={onCancel}>留在本页</button>
          <button onClick={onOk}>放弃并离开</button>
          {children}
        </div>
      ) : null,
  };
});

vi.mock('../../request/feedback', () => ({
  useFeedback: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../request/session', () => ({
  useSession: () => ({ can: () => true }),
}));

vi.mock('../../request/http', () => ({
  http: {
    get: vi.fn((path: string) => {
      if (path.startsWith('/profit/projects')) {
        return Promise.resolve({ data: [{ id: 1, name: '测试项目', contractAmount: '100', invoicedAmount: '0', receivedAmount: '0' }] });
      }
      if (path === '/profit/totals') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    }),
  },
}));

/** 导航触发器 + 当前路径显示（MemoryRouter 内才能触发 location 变化） */
function NavProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div>
      <button onClick={() => navigate('/fin/projects')}>去工程合同</button>
      <span data-testid="current-path">{location.pathname}</span>
    </div>
  );
}

function renderProfit() {
  return render(
    <MemoryRouter initialEntries={['/fin/profit']}>
      <ProfitAnalysis />
      <NavProbe />
    </MemoryRouter>,
  );
}

describe('ProfitAnalysis 离开保护（M22）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无草稿时站内导航不弹确认', async () => {
    renderProfit();
    // 等待数据加载完成（输入框出现）
    const amountInput = await screen.findByLabelText('测试项目 contractAmount');
    expect(amountInput).toBeTruthy();
    await userEvent.click(screen.getByText('去工程合同'));
    await waitFor(() => expect(screen.getByTestId('current-path').textContent).toBe('/fin/projects'));
    expect(screen.queryByTestId('leave-modal')).toBeNull();
  });

  it('有草稿时导航弹确认，「留在本页」回退且不重复弹窗', async () => {
    const user = userEvent.setup();
    renderProfit();
    const amountInput = await screen.findByLabelText('测试项目 contractAmount');
    // 金额输入框（rc-input-number）在 jsdom 下不走 userEvent 键盘序列，用 change 事件产生草稿
    fireEvent.change(amountInput, { target: { value: '200' } });
    expect(await screen.findByText(/1 个未提交草稿/)).toBeTruthy();
    // 触发站内导航 → 应弹确认
    await user.click(screen.getByText('去工程合同'));
    expect(await screen.findByTestId('leave-modal')).toBeTruthy();
    // 留在本页 → 回退到 /fin/profit 且 Modal 关闭
    await user.click(screen.getByRole('button', { name: '留在本页' }));
    await waitFor(() => expect(screen.getByTestId('current-path').textContent).toBe('/fin/profit'));
    await waitFor(() => expect(screen.queryByTestId('leave-modal')).toBeNull());
  });

  it('有草稿时导航弹确认，「放弃并离开」放行', async () => {
    const user = userEvent.setup();
    renderProfit();
    const amountInput = await screen.findByLabelText('测试项目 contractAmount');
    fireEvent.change(amountInput, { target: { value: '300' } });
    expect(await screen.findByText(/1 个未提交草稿/)).toBeTruthy();
    await user.click(screen.getByText('去工程合同'));
    expect(await screen.findByTestId('leave-modal')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '放弃并离开' }));
    await waitFor(() => expect(screen.getByTestId('current-path').textContent).toBe('/fin/projects'));
    await waitFor(() => expect(screen.queryByTestId('leave-modal')).toBeNull());
  });
});
