import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http } from '../../request/http';
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
  const { createPortal } = await import('react-dom');
  return {
    ...actual,
    // 真实 antd Modal 渲染在 body 顶层 portal（不受父容器 display:none 影响）；
    // mock 同样经 portal 渲染，否则容器结构下（利润分析常驻 display:none）弹窗
    // 被 testing-library 视为不可见，测试与生产行为不一致
    Modal: ({ open, onOk, onCancel, children }: { open?: boolean; onOk?: () => void; onCancel?: () => void; children?: React.ReactNode }) =>
      open
        ? createPortal(
            <div data-testid="leave-modal">
              <p>未保存的编辑内容</p>
              <button onClick={onCancel}>留在本页</button>
              <button onClick={onOk}>放弃并离开</button>
              {children}
            </div>,
            document.body,
          )
        : null,
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
    // 默认实现：成功返回；保存中/放弃失败两用例经 mockImplementationOnce 覆盖为挂起/可拒绝
    put: vi.fn(() => Promise.resolve({ value: null, auto: {}, dataRevision: 1 })),
  },
}));

/** 导航触发器 + 当前路径显示（MemoryRouter 内才能触发 location 变化） */
function NavProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div>
      <button onClick={() => navigate('/fin/projects')}>去工程合同</button>
      <button onClick={() => navigate('/fin/profit')}>回利润分析</button>
      <span data-testid="current-path">{location.pathname}</span>
    </div>
  );
}

/**
 * 与生产 FinPage 一致的容器结构（M22 复核修复）：
 * 利润分析常驻渲染（非当前页 display:none），其余 section 由 switch 切换——
 * 若 ProfitAnalysis 随切换卸载，location 检测 effect 不会以新 location 执行，
 * 站内离开保护即失效；本容器结构使测试与生产行为一致，防回归。
 */
function ContainerLike() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] ?? '';
  // 与生产 FinPage 的 switch 结构一致：profit 必须显式命中空分支；
  // 若 case 'profit' 缺失会落入 default（生产为 SystemHome 欢迎页叠放），
  // 由「profit 分支不渲染其它页面内容」用例兜底防回归（M22 复核回归修复）。
  const body = (() => {
    switch (section) {
      case 'profit':
        return null;
      default:
        return <div data-testid="other-page">其他页面</div>;
    }
  })();
  return (
    <div>
      {body}
      <div style={{ display: section === 'profit' ? undefined : 'none' }}>
        <ProfitAnalysis />
      </div>
      <NavProbe />
    </div>
  );
}

function renderProfit() {
  return render(
    <MemoryRouter initialEntries={['/fin/profit']}>
      <ContainerLike />
    </MemoryRouter>,
  );
}

describe('ProfitAnalysis 离开保护（M22）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('/fin/profit 命中 profit 分支，不渲染其它页面内容（防 case 缺失回归）', async () => {
    renderProfit();
    expect(await screen.findByLabelText('测试项目 contractAmount')).toBeTruthy();
    expect(screen.queryByTestId('other-page')).toBeNull();
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

  it('确认「放弃并离开」后保护复位：再次编辑并离开仍弹确认（M22 回归）', async () => {
    const user = userEvent.setup();
    renderProfit();
    const amountInput = await screen.findByLabelText('测试项目 contractAmount');
    // 第一次：产生草稿 → 离开 → 确认放弃
    fireEvent.change(amountInput, { target: { value: '300' } });
    expect(await screen.findByText(/1 个未提交草稿/)).toBeTruthy();
    await user.click(screen.getByText('去工程合同'));
    expect(await screen.findByTestId('leave-modal')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '放弃并离开' }));
    await waitFor(() => expect(screen.getByTestId('current-path').textContent).toBe('/fin/projects'));
    await waitFor(() => expect(screen.queryByTestId('leave-modal')).toBeNull());
    // 草稿已清空（确认放弃语义），回到本页后重新编辑
    expect(screen.queryByText(/未提交草稿/)).toBeNull();
    await user.click(screen.getByText('回利润分析'));
    await waitFor(() => expect(screen.getByTestId('current-path').textContent).toBe('/fin/profit'));
    const amountInput2 = await screen.findByLabelText('测试项目 contractAmount');
    fireEvent.change(amountInput2, { target: { value: '400' } });
    expect(await screen.findByText(/1 个未提交草稿/)).toBeTruthy();
    // 第二次离开：保护必须重新生效（修复前 leaveConfirmedRef 永不复位导致不再弹窗）
    await user.click(screen.getByText('去工程合同'));
    expect(await screen.findByTestId('leave-modal')).toBeTruthy();
  });

  it('保存请求在途（saving）时导航仍弹确认（竞态修复：保存在途离开无感知）', async () => {
    const user = userEvent.setup();
    renderProfit();
    const nameInput = await screen.findByLabelText('测试项目 name');
    // 保存请求挂起不 resolve，saveState 保持 saving（修复前 saving 不参与离开判定，
    // 导航直接放行，保存随后失败时用户已在别的页面且无任何提示）
    vi.mocked(http.put).mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.change(nameInput, { target: { value: '改名' } });
    fireEvent.blur(nameInput);
    expect(await screen.findByText('保存中...')).toBeTruthy();
    await user.click(screen.getByText('去工程合同'));
    expect(await screen.findByTestId('leave-modal')).toBeTruthy();
  });

  it('确认放弃后，在途保存失败不重新标记：再次导航不弹确认（竞态修复：二次拦截）', async () => {
    const user = userEvent.setup();
    renderProfit();
    const nameInput = await screen.findByLabelText('测试项目 name');
    const deferred: { reject: (reason?: unknown) => void } = { reject: () => {} };
    vi.mocked(http.put).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { deferred.reject = reject; }),
    );
    fireEvent.change(nameInput, { target: { value: '改名' } });
    fireEvent.blur(nameInput);
    expect(await screen.findByText('保存中...')).toBeTruthy();
    // 保存在途时导航 → 弹确认
    await user.click(screen.getByText('去工程合同'));
    expect(await screen.findByTestId('leave-modal')).toBeTruthy();
    // 确认放弃 → 放行；随后在途保存请求失败（发起于放弃之前）
    await user.click(screen.getByRole('button', { name: '放弃并离开' }));
    await waitFor(() => expect(screen.getByTestId('current-path').textContent).toBe('/fin/projects'));
    deferred.reject(new Error('network down'));
    await waitFor(() => expect(screen.getByText('保存失败，请重试或检查网络')).toBeTruthy());
    // 失败发生在放弃之后：dirtyRef 不应被重新置位，再次导航不弹确认
    // （修复前在途失败把 dirtyRef 置 true，用户已在别的页面仍被无端二次拦截）
    await user.click(screen.getByText('回利润分析'));
    await waitFor(() => expect(screen.getByTestId('current-path').textContent).toBe('/fin/profit'));
    expect(screen.queryByTestId('leave-modal')).toBeNull();
  });
});
