import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavigationItem } from '../components/AppShell';
import type { SystemMenuConfig } from './types';

const httpMock = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
const feedbackMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  confirmDanger: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../request/http', () => ({ http: httpMock }));
vi.mock('../request/feedback', () => ({ useFeedback: () => feedbackMock }));

import { MenuManagementTab } from './MenuManagementTab';

const FIXTURE: NavigationItem[] = [
  { key: 'my-assets', label: '我的资产', path: '/asset/my-assets', group: '固定资产' },
  { key: 'assets', label: '固定资产台账', path: '/asset/assets', group: '固定资产' },
  { key: 'consumables', label: '品类管理', path: '/asset/consumables', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'warehouses', label: '库位管理', path: '/asset/warehouses', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'claims', label: '我的申领', path: '/asset/claims', group: '消耗品', subGroup: '消耗品申领' },
  { key: 'approval', label: '审批中心', path: '/asset/approval' },
  { key: 'config', label: '系统设置', path: '/asset/config' },
];

const EMPTY: SystemMenuConfig = { groups: [], items: [] };

describe('菜单管理 Tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    httpMock.get.mockResolvedValue(EMPTY);
    httpMock.put.mockResolvedValue({});
    httpMock.delete.mockResolvedValue({});
    feedbackMock.confirmDanger.mockResolvedValue(true);
  });

  it('按配置渲染树（分组改名生效），改名 → 保存产生整树 PUT 载荷并回调 onSaved', async () => {
    httpMock.get.mockResolvedValue({
      groups: [{ nodeKey: '固定资产', parentKey: null, nameOverride: '固定资产管理', sortOrder: 0 }],
      items: [],
    });
    const onSaved = vi.fn();
    render(<MenuManagementTab systemCode="ASSET" defaults={FIXTURE} onSaved={onSaved} />);

    // 配置中的分组改名生效，并显示默认名辅助文字
    expect(await screen.findByText('固定资产管理')).toBeTruthy();
    expect(screen.getByText('默认：固定资产')).toBeTruthy();
    // 默认结构渲染：二级分组与顶层叶子
    expect(screen.getByText('消耗品管理')).toBeTruthy();
    expect(screen.getByText('审批中心')).toBeTruthy();

    // 改名：我的资产 → 我的资产清单
    fireEvent.click(screen.getByLabelText('重命名 我的资产'));
    fireEvent.change(screen.getByPlaceholderText('默认名：我的资产（留空恢复默认）'), { target: { value: '我的资产清单' } });
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    expect(screen.getByText('有未保存的修改')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(httpMock.put).toHaveBeenCalledTimes(1));
    const [path, payload] = httpMock.put.mock.calls[0] as unknown as [string, SystemMenuConfig];
    expect(path).toBe('/system-menu-configs/ASSET');
    expect(payload.items.find((row) => row.itemKey === 'my-assets')?.nameOverride).toBe('我的资产清单');
    expect(payload.groups.find((row) => row.nodeKey === '固定资产')?.nameOverride).toBe('固定资产管理');
    // 整树载荷：7 个菜单项 + 4 个分组（2 个一级 + 2 个二级）
    expect(payload.items).toHaveLength(7);
    expect(payload.groups).toHaveLength(4);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('新建分组：创建自定义分组并重命名后保存到整树载荷', async () => {
    const onSaved = vi.fn();
    render(<MenuManagementTab systemCode="ASSET" defaults={FIXTURE} onSaved={onSaved} />);
    expect(await screen.findByText('固定资产')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /新建分组/ }));
    expect(screen.getByPlaceholderText('默认名：新分组（留空恢复默认）')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('默认名：新分组（留空恢复默认）'), { target: { value: '加班管理' } });
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
    expect(screen.getByText('有未保存的修改')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));
    await waitFor(() => expect(httpMock.put).toHaveBeenCalledTimes(1));
    const [path, payload] = httpMock.put.mock.calls[0] as unknown as [string, SystemMenuConfig];
    expect(path).toBe('/system-menu-configs/ASSET');
    const customGroup = payload.groups.find((row) => row.nodeKey.startsWith('custom:'));
    expect(customGroup).toBeDefined();
    expect(customGroup?.nameOverride).toBe('加班管理');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('新建分组后可删除空分组，保存载荷不再包含该分组', async () => {
    const onSaved = vi.fn();
    render(<MenuManagementTab systemCode="ASSET" defaults={FIXTURE} onSaved={onSaved} />);
    expect(await screen.findByText('固定资产')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /新建分组/ }));
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));
    fireEvent.click(screen.getByLabelText('删除分组 新分组'));
    fireEvent.click(screen.getByRole('button', { name: /删\s*除$/ }));
    expect(screen.getByText('有未保存的修改')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));
    await waitFor(() => expect(httpMock.put).toHaveBeenCalledTimes(1));
    const [path, payload] = httpMock.put.mock.calls[0] as unknown as [string, SystemMenuConfig];
    expect(path).toBe('/system-menu-configs/ASSET');
    expect(payload.groups.some((row) => row.nodeKey.startsWith('custom:'))).toBe(false);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('恢复默认：确认后 DELETE 并重建默认树', async () => {
    const onSaved = vi.fn();
    render(<MenuManagementTab systemCode="ASSET" defaults={FIXTURE} onSaved={onSaved} />);
    expect(await screen.findByText('固定资产')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /恢复默认/ }));
    await waitFor(() => expect(httpMock.delete).toHaveBeenCalledWith('/system-menu-configs/ASSET'));
    expect(feedbackMock.confirmDanger).toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('加载失败：提示加载失败并可重试', async () => {
    httpMock.get.mockRejectedValueOnce(new Error('network'));
    render(<MenuManagementTab systemCode="ASSET" defaults={FIXTURE} onSaved={vi.fn()} />);
    expect(await screen.findByText('菜单配置加载失败。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() => expect(httpMock.get).toHaveBeenCalledTimes(2));
  });
});
