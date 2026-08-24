import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable, type DataColumn } from './DataTable';
import { FeedbackProvider } from '../request/feedback';
import { http } from '../request/http';

vi.mock('../request/http', () => ({
  http: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  download: vi.fn(),
}));

vi.mock('../request/session', () => ({
  useSession: () => ({ user: null, can: () => false }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <FeedbackProvider>{children}</FeedbackProvider>;
}

const emptyListResponse = {
  data: [],
  pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
};

const emptyPresetsResponse = { items: [] };
const emptyColumnsResponse = { item: null };

async function renderDataTable(columns: DataColumn[], data: Record<string, unknown>[] = []) {
  vi.mocked(http.get)
    .mockResolvedValueOnce({ ...emptyListResponse, data })
    .mockResolvedValueOnce(emptyPresetsResponse)
    .mockResolvedValueOnce(emptyColumnsResponse);

  render(
    <DataTable
      title="测试表格"
      service="asset"
      endpoint="/test"
      pageKey="test-page"
      columns={columns}
    />,
    { wrapper },
  );

  await waitFor(() => {
    expect(http.get).toHaveBeenCalledWith('/test?page=1&pageSize=20', { service: 'asset', active: true });
  });
}

describe('DataTable 排序面板', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('排序字段下拉仅包含声明为 sortable 的列', async () => {
    const user = userEvent.setup();
    await renderDataTable([
      { key: 'name', title: '名称', sortable: true },
      { key: 'status', title: '状态' },
      { key: 'createdAt', title: '创建时间', sortable: true },
    ]);

    await user.click(screen.getByRole('button', { name: /排序/ }));
    await screen.findByText('排序', { selector: '.ant-drawer-title' });

    await user.click(screen.getByRole('button', { name: '添加排序字段' }));
    const fieldSelect = screen.getByRole('combobox', { name: '排序字段' });
    await user.click(fieldSelect);

    await waitFor(() => {
      expect(document.querySelector('.ant-select-dropdown')).toBeTruthy();
    });

    const optionTexts = Array.from(document.querySelectorAll('.ant-select-item-option-content')).map((el) => el.textContent);
    expect(optionTexts).toContain('名称');
    expect(optionTexts).toContain('创建时间');
    expect(optionTexts).not.toContain('状态');
  });

  it('无可排序列时不渲染排序按钮', async () => {
    await renderDataTable([
      { key: 'status', title: '状态' },
      { key: 'departmentName', title: '部门' },
    ]);

    expect(screen.queryByRole('button', { name: /排序/ })).toBeFalsy();
  });

  it('添加排序字段时默认选中第一个可排序列', async () => {
    const user = userEvent.setup();
    await renderDataTable([
      { key: 'status', title: '状态' },
      { key: 'name', title: '名称', sortable: true },
      { key: 'createdAt', title: '创建时间', sortable: true },
    ]);

    await user.click(screen.getByRole('button', { name: /排序/ }));
    await screen.findByText('排序', { selector: '.ant-drawer-title' });

    await user.click(screen.getByRole('button', { name: '添加排序字段' }));
    const fieldSelect = screen.getByRole('combobox', { name: '排序字段' });
    expect(fieldSelect.parentElement?.textContent).toBe('名称');
  });

  it('带枚举领域的列不会直接展示接口英文编码', async () => {
    await renderDataTable(
      [{ key: 'actionType', title: '操作', enumKind: 'operationAction' }],
      [{ id: 1, actionType: 'QUERY' }],
    );

    expect((await screen.findAllByText('查询')).length).toBeGreaterThan(0);
    expect(screen.queryByText('QUERY')).toBeNull();
  });
});
