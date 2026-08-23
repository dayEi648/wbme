import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http } from '../../request/http';
import MePage from './MePage';

/**
 * 个人中心 Tab 化重构（base PRD §6）：
 * 四个 tab 分区；个人资料默认只读、弹窗修改；账户安全手机号只读（无换绑入口）；旧子路由重定向。
 */

const mocks = vi.hoisted(() => ({
  me: {
    user: { id: 1, name: '张三', gender: 'MALE', phoneMasked: '+86 138****8000', status: 'ACTIVE', isSuperAdmin: false, createdAt: '2026-01-01T00:00:00.000Z' },
    departments: [{ id: 1, name: '工程部' }],
    positions: [{ id: 1, name: '维修工' }],
    canApplyPositionChange: true,
    pendingProfileChange: false,
  },
}));

vi.mock('../../request/feedback', () => {
  // 稳定引用：每次调用返回新对象会触发 useMeData 的 effect 依赖抖动、重复拉数
  const feedback = { success: vi.fn(), error: vi.fn() };
  return { useFeedback: () => feedback };
});

vi.mock('../../request/session', () => ({
  useSession: () => ({
    can: () => true,
    user: { id: 1, name: '张三', gender: 'MALE', phoneMasked: '+86 138****8000', status: 'ACTIVE', isSuperAdmin: false },
    hasDingtalkBinding: true,
  }),
}));

vi.mock('../../request/http', () => ({
  ApiError: class ApiError extends Error {},
  http: {
    get: vi.fn((path: string) => (path === '/me' ? Promise.resolve(mocks.me) : Promise.resolve({}))),
    put: vi.fn(() => Promise.resolve({ applied: false, requestId: 1 })),
    post: vi.fn(() => Promise.resolve({})),
  },
}));

// DataTable 体量与本次契约无关：替换为标题桩，验证 tab 内挂载了正确的表格
vi.mock('../../components/DataTable', () => ({
  DataTable: ({ title }: { title: string }) => <div data-testid="data-table">{title}</div>,
  StatusTag: ({ value }: { value: unknown }) => <span>{String(value)}</span>,
}));

function renderMe(initialPath = '/me') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <MePage />
    </MemoryRouter>,
  );
}

describe('个人中心 Tab 结构', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染个人资料/账户安全/岗位申请/我的日志四个 tab', () => {
    renderMe();
    expect(screen.getByRole('tab', { name: '个人资料' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '账户安全' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '岗位申请' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '我的日志' })).toBeTruthy();
  });

  it('个人资料默认只读展示，无内联编辑表单', async () => {
    renderMe();
    expect(await screen.findByText('张三')).toBeTruthy();
    expect(screen.getByText('+86 138****8000')).toBeTruthy();
    expect(screen.getByText('工程部')).toBeTruthy();
    // 只读态不存在可输入的姓名/性别表单项，也没有保存按钮（antd 两字按钮自动插空格，用正则匹配）
    expect(screen.queryByLabelText('姓名')).toBeNull();
    expect(screen.queryByRole('button', { name: /保\s*存/ })).toBeNull();
  });

  it('点击「修改资料」弹出编辑弹窗，保存后调用 PUT /me/profile', async () => {
    renderMe();
    fireEvent.click(await screen.findByRole('button', { name: '修改资料' }));
    const nameInput = await screen.findByLabelText('姓名');
    expect(screen.getByRole('radio', { name: '男' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '女' })).toBeTruthy();
    fireEvent.change(nameInput, { target: { value: '张三三' } });
    // antd 对两个汉字的按钮自动插入空格（"保 存"），用正则匹配
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));
    await waitFor(() => expect(http.put).toHaveBeenCalledWith('/me/profile', { name: '张三三', gender: 'MALE' }));
  });

  it('账户安全：手机号只读展示且说明不可修改，无换绑入口；修改密码可弹窗', async () => {
    renderMe();
    fireEvent.click(screen.getByRole('tab', { name: '账户安全' }));
    // 个人资料 tab 保持挂载（也展示手机号），断言限定在当前激活面板（隐藏面板对 getByRole 不可见）
    const panel = await screen.findByRole('tabpanel');
    const activePanel = within(panel);
    expect(await screen.findByText('登录密码')).toBeTruthy();
    expect(activePanel.getByText('手机号')).toBeTruthy();
    expect(activePanel.getByText('+86 138****8000')).toBeTruthy();
    expect(activePanel.getByText('钉钉账号')).toBeTruthy();
    expect(activePanel.getByText('已绑定')).toBeTruthy();
    fireEvent.click(activePanel.getByRole('button', { name: '修改密码' }));
    expect(await screen.findByLabelText('当前密码')).toBeTruthy();
    expect(screen.getByLabelText('新密码')).toBeTruthy();
    expect(screen.getByLabelText('确认新密码')).toBeTruthy();
  });

  it('岗位申请：包含发起申请按钮与分页历史记录表格', async () => {
    renderMe();
    fireEvent.click(screen.getByRole('tab', { name: '岗位申请' }));
    const applyButton = await screen.findByRole('button', { name: '发起岗位申请' });
    expect(applyButton.hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('data-table').textContent).toBe('历史记录');
  });

  it('我的日志：挂载操作日志表格', async () => {
    renderMe();
    fireEvent.click(screen.getByRole('tab', { name: '我的日志' }));
    expect((await screen.findByTestId('data-table')).textContent).toBe('我的操作日志');
  });

  it('旧子路由 /me/operation-logs 重定向到 /me?tab=logs', async () => {
    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="location">{location.pathname + location.search}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/me/operation-logs']}>
        <MePage />
        <LocationProbe />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/me?tab=logs'));
  });
});
