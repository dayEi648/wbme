import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http } from '../request/http';
import { ApprovalCenter } from './ApprovalCenter';

/**
 * asset 审批详情「申请对象」渲染回归（主 PRD §3.2）：
 * asset getDetail 返回 detail 后，前端按 requestType 分支渲染名称快照
 * （STOCK_IN 入库明细表；AGENT_REQUEST 申领明细 + 受领人名单）。
 */

const mocks = vi.hoisted(() => ({
  row: { id: 1, requestType: 'STOCK_IN', applicantName: '张三', applicantId: 1, status: 'PENDING' } as Record<string, unknown>,
  detail: {} as Record<string, unknown>,
}));

vi.mock('../request/feedback', () => {
  // 稳定引用：每次调用返回新对象会使详情 effect 依赖抖动、清理标记取消加载
  const feedback = { success: vi.fn(), error: vi.fn() };
  return { useFeedback: () => feedback };
});

vi.mock('../request/session', () => ({
  useSession: () => ({ user: { id: 999 } }),
}));

vi.mock('../request/http', () => ({
  http: {
    get: vi.fn(() => Promise.resolve(mocks.detail)),
    post: vi.fn(() => Promise.resolve({ ok: true })),
  },
}));

// DataTable 体量与本次契约无关：替换为行数据注入 + 点击触发 onRowClick 的最小桩
vi.mock('./DataTable', () => ({
  DataTable: (props: {
    onRowsLoaded?: (rows: Record<string, unknown>[]) => void;
    onRowClick?: (row: Record<string, unknown>) => void;
  }) => {
    useEffect(() => {
      props.onRowsLoaded?.([mocks.row]);
    }, []);
    return <button type="button" onClick={() => props.onRowClick?.(mocks.row)}>打开详情</button>;
  },
  StatusTag: ({ value }: { value: unknown }) => <span>{String(value)}</span>,
}));

async function openDetail() {
  render(<ApprovalCenter title="审批中心" service="asset" pageKey="asset-approvals" />);
  fireEvent.click(await screen.findByText('打开详情'));
  await waitFor(() => expect(http.get).toHaveBeenCalledWith(`/approval-requests/${String(mocks.row.id)}`, expect.objectContaining({ service: 'asset' })));
}

describe('ApprovalCenter asset 申请对象（主 PRD §3.2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('STOCK_IN：渲染入库明细表（品种/库位/供应商名称快照）', async () => {
    mocks.row = { id: 1, requestType: 'STOCK_IN', applicantName: '张三', applicantId: 1, status: 'PENDING' };
    mocks.detail = {
      request: { id: 1, applicationNo: 'AS-0001', requestType: 'STOCK_IN', applicantName: '张三', applicantId: 1, status: 'PENDING' },
      detail: [{
        id: 11, consumableName: '测试入库品种', spec: '标准', warehouseName: '主仓', qty: 3,
        unitPrice: '12.50', supplierName: '测试供应商', brandName: '测试品牌', receivedAt: '2026-08-01T00:00:00.000Z',
      }],
      actions: [],
    };
    await openDetail();
    expect(await screen.findByText('申请对象')).toBeTruthy();
    expect(await screen.findByText('测试入库品种')).toBeTruthy();
    expect(screen.getByText('测试供应商')).toBeTruthy();
    expect(screen.getByText('主仓')).toBeTruthy();
  });

  it('AGENT_REQUEST：渲染申领明细与受领人名单', async () => {
    mocks.row = { id: 2, requestType: 'AGENT_REQUEST', applicantName: '李代交', applicantId: 2, status: 'PENDING' };
    mocks.detail = {
      request: { id: 2, applicationNo: 'AS-0002', requestType: 'AGENT_REQUEST', applicantName: '李代交', applicantId: 2, status: 'PENDING' },
      detail: {
        items: [{ id: 21, consumableName: '代领共享品', spec: '标准', warehouseName: '主仓', qty: 2, purpose: '办公' }],
        recipients: [{ id: 31, userName: '王受领' }],
      },
      actions: [],
    };
    await openDetail();
    expect(await screen.findByText('申领明细')).toBeTruthy();
    expect(screen.getByText('代领共享品')).toBeTruthy();
    expect(screen.getByText('受领人')).toBeTruthy();
    expect(screen.getByText('王受领')).toBeTruthy();
  });

  it('WRITE_OFF：渲染借还记录快照与核销类型中文', async () => {
    mocks.row = { id: 3, requestType: 'WRITE_OFF', applicantName: '张三', applicantId: 1, status: 'PENDING' };
    mocks.detail = {
      request: { id: 3, applicationNo: 'AS-0003', requestType: 'WRITE_OFF', applicantName: '张三', applicantId: 1, status: 'PENDING' },
      detail: [{
        id: 41, qty: 1, writeOffType: 'LOST', reason: '遗失在出差途中',
        borrowRecord: { consumableName: '测试借还品', spec: '标准', warehouseName: '主仓', userName: '张三' },
      }],
      actions: [],
    };
    await openDetail();
    expect(await screen.findByText('测试借还品')).toBeTruthy();
    expect(screen.getByText('遗失')).toBeTruthy();
    expect(screen.getByText('遗失在出差途中')).toBeTruthy();
  });
});
