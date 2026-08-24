import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { download, http } from '../../request/http';
import { ProfitAnalysis } from './FinPage';

/**
 * 批次 6 利润分析交互契约（fin PRD §4）：
 * 撤销/重做（⌘Z / ⌘⇧Z）、dataRevision 响应排序保护、同单元格串行保存、
 * 应用筛选后列表与总计携带筛选条件、导出已筛选携带筛选条件。
 */

vi.mock('../../request/feedback', () => ({
  useFeedback: () => ({ success: vi.fn(), error: vi.fn(), confirm: vi.fn(() => Promise.resolve(true)), confirmDanger: vi.fn(() => Promise.resolve(true)) }),
}));

vi.mock('../../request/session', () => ({
  useSession: () => ({ can: () => true }),
}));

vi.mock('../../request/http', () => ({
  http: {
    get: vi.fn((path: string) => {
      if (path.startsWith('/profit/projects')) {
        return Promise.resolve({ data: [{ id: 1, name: '测试项目', paymentNode: '主合同付款节点', tentativeAuditedAmount: '100', dataRevision: 0 }], pagination: { totalItems: 1 } });
      }
      if (path.startsWith('/profit/totals')) {
        return Promise.resolve({ totalReceived: '0.00', totalSubcontractPaid: '0.00', equity: '0.00', grossMargin: null });
      }
      return Promise.resolve({});
    }),
    put: vi.fn(),
  },
  download: vi.fn(() => Promise.resolve(new Blob())),
}));

/** 可编辑字段的桌面输入框（移动端卡片第二个实例；桌面表格先渲染取第一个）。 */
const fieldInput = (label: string): Promise<HTMLElement> =>
  screen.findAllByLabelText(label).then((elements) => elements[0] as HTMLElement);

function renderProfit() {
  return render(
    <MemoryRouter initialEntries={['/fin/profit']}>
      <ProfitAnalysis />
    </MemoryRouter>,
  );
}

/** 成功保存的默认 put 实现（dataRevision 递增）。 */
function successPut(sequence: { revision: number }) {
  return (_path: string, body: unknown) => {
    const { field, value } = body as { projectId: number; field: string; value: string };
    return Promise.resolve({ field, value, auto: {}, dataRevision: ++sequence.revision });
  };
}

describe('ProfitAnalysis 交互契约（批次 6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('保存成功后 ⌘Z 撤销、⌘⇧Z 重做已保存编辑，并回显对应值', async () => {
    const sequence = { revision: 0 };
    vi.mocked(http.put).mockImplementation(successPut(sequence));
    renderProfit();
    const input = await fieldInput('测试项目 paymentNode') as HTMLInputElement;

    // 编辑并失焦 → 保存成功（revision 1）
    fireEvent.change(input, { target: { value: '节点B' } });
    fireEvent.blur(input);
    await waitFor(() => expect(http.put).toHaveBeenCalledTimes(1));
    expect(vi.mocked(http.put).mock.calls[0]?.[1]).toMatchObject({ field: 'paymentNode', value: '节点B' });

    // 撤销/重做栈保存在 React state 中：等待保存成功的副作用提交并重渲染后再触发快捷键，
    // 否则快捷键处理器读到的仍是旧栈（偶发时序失败）；按钮禁用态即栈状态的可见表达
    await waitFor(() => expect((screen.getByRole('button', { name: /撤\s*销/ }) as HTMLButtonElement).disabled).toBe(false));

    // ⌘Z 撤销：重新提交编辑前值（主合同付款节点）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    await waitFor(() => expect(http.put).toHaveBeenCalledTimes(2));
    expect(vi.mocked(http.put).mock.calls[1]?.[1]).toMatchObject({ field: 'paymentNode', value: '主合同付款节点' });
    const nodeAfter = await fieldInput('测试项目 paymentNode') as HTMLInputElement;
    await waitFor(() => expect(nodeAfter.value).toBe('主合同付款节点'));
    await waitFor(() => expect((screen.getByRole('button', { name: /重\s*做/ }) as HTMLButtonElement).disabled).toBe(false));

    // ⌘⇧Z 重做：重新提交编辑后值（节点B）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true }));
    await waitFor(() => expect(http.put).toHaveBeenCalledTimes(3));
    expect(vi.mocked(http.put).mock.calls[2]?.[1]).toMatchObject({ field: 'paymentNode', value: '节点B' });
    const nodeRedone = await fieldInput('测试项目 paymentNode') as HTMLInputElement;
    await waitFor(() => expect(nodeRedone.value).toBe('节点B'));
  });

  it('新编辑提交后清空重做栈：撤销后再编辑不可重做旧值', async () => {
    const sequence = { revision: 0 };
    vi.mocked(http.put).mockImplementation(successPut(sequence));
    renderProfit();
    const input = await fieldInput('测试项目 paymentNode') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '节点B' } });
    fireEvent.blur(input);
    await waitFor(() => expect(http.put).toHaveBeenCalledTimes(1));
    // 等待保存成功副作用提交（撤销栈入栈）并重渲染，再触发快捷键
    await waitFor(() => expect((screen.getByRole('button', { name: /撤\s*销/ }) as HTMLButtonElement).disabled).toBe(false));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    await waitFor(() => expect(http.put).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByRole('button', { name: /重\s*做/ }) as HTMLButtonElement).disabled).toBe(false));

    // 撤销后新编辑（revision 3）：重做栈被清空（等待清空副作用重渲染：重做按钮变禁用）
    fireEvent.change(input, { target: { value: '节点C' } });
    fireEvent.blur(input);
    await waitFor(() => expect(http.put).toHaveBeenCalledTimes(3));
    await waitFor(() => expect((screen.getByRole('button', { name: /重\s*做/ }) as HTMLButtonElement).disabled).toBe(true));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true }));
    // 重做栈为空：不发起请求
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(http.put).toHaveBeenCalledTimes(3);
  });

  it('dataRevision 排序保护：不同单元格并行时旧响应不覆盖新值', async () => {
    const sequence = { revision: 0 };
    const put = vi.mocked(http.put);
    put.mockImplementation(successPut(sequence));
    renderProfit();
    const nodeInput = await fieldInput('测试项目 paymentNode') as HTMLInputElement;
    const remarkInput = await fieldInput('测试项目 remark') as HTMLInputElement;
    const deferredOld: { resolve: (value: unknown) => void } = { resolve: () => {} };

    // 第一次保存（paymentNode）挂起——旧响应稍后到达
    put.mockImplementationOnce(() => new Promise((resolve) => { deferredOld.resolve = resolve; }));
    fireEvent.change(nodeInput, { target: { value: '节点B' } });
    fireEvent.blur(nodeInput);
    // 另一单元格（remark）保存成功 → 行 dataRevision 变为 1
    fireEvent.change(remarkInput, { target: { value: '备注C' } });
    fireEvent.blur(remarkInput);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    const remarkAfter = await fieldInput('测试项目 remark') as HTMLInputElement;
    await waitFor(() => expect(remarkAfter.value).toBe('备注C'));

    // 旧响应（dataRevision 0 < 当前 1）迟到：不得覆盖新值
    deferredOld.resolve({ field: 'paymentNode', value: '节点B', auto: {}, dataRevision: 0 });
    const nodeAfter = await fieldInput('测试项目 paymentNode') as HTMLInputElement;
    await waitFor(() => expect(nodeAfter.value).toBe('主合同付款节点'));
    expect((await fieldInput('测试项目 remark') as HTMLInputElement).value).toBe('备注C');
  });

  it('相同单元格连续保存按发起顺序串行处理', async () => {
    const sequence = { revision: 0 };
    const calls: string[] = [];
    vi.mocked(http.put).mockImplementation((_path: string, body: unknown) => {
      const { field, value } = body as { field: string; value: string };
      calls.push(`start:${value}`);
      return new Promise((resolve) => {
        setTimeout(() => {
          calls.push(`done:${value}`);
          resolve({ field, value, auto: {}, dataRevision: ++sequence.revision });
        }, 10);
      });
    });
    renderProfit();
    const input = await fieldInput('测试项目 paymentNode') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '节点B' } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '节点C' } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls.filter((item) => item.startsWith('done')).length).toBe(2));
    // 串行：第二次保存必须等待第一次完成（不并发插队）
    expect(calls).toEqual(['start:节点B', 'done:节点B', 'start:节点C', 'done:节点C']);
  });

  it('应用筛选后列表与总计携带筛选条件（总计随筛选实时计算）', async () => {
    vi.mocked(http.put).mockImplementation(successPut({ revision: 0 }));
    renderProfit();
    await fieldInput('测试项目 paymentNode');

    // 统一高级筛选：打开后默认已选中第一个字段「项目名称」，直接填值并确定
    fireEvent.click(screen.getAllByRole('button', { name: /筛\s*选/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText('请输入'), { target: { value: '某某' } });
    fireEvent.click(screen.getByText('确 定'));
    await waitFor(() => {
      const paths = vi.mocked(http.get).mock.calls.map((call) => String(call[0]));
      expect(paths.some((path) => path.startsWith('/profit/projects?') && path.includes('page=1&pageSize=20') && decodeURIComponent(path).includes('filters=') && decodeURIComponent(path).includes('"field":"name"') && decodeURIComponent(path).includes('"value":"某某"'))).toBe(true);
      expect(paths.some((path) => path.startsWith('/profit/totals?') && decodeURIComponent(path).includes('filters=') && decodeURIComponent(path).includes('"field":"name"') && decodeURIComponent(path).includes('"value":"某某"'))).toBe(true);
    });
  });

  it('导出已筛选携带当前筛选条件；导出全部不携带', async () => {
    vi.mocked(http.put).mockImplementation(successPut({ revision: 0 }));
    renderProfit();
    await fieldInput('测试项目 paymentNode');

    fireEvent.click(screen.getAllByRole('button', { name: /筛\s*选/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText('请输入'), { target: { value: '某某' } });
    fireEvent.click(screen.getByText('确 定'));
    await waitFor(() => expect(http.get).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /导出已筛选/ }));
    await waitFor(() => {
      const paths = vi.mocked(download).mock.calls.map((call) => String(call[0]));
      expect(paths.some((path) => path.startsWith('/profit/excel/export/filtered?') && decodeURIComponent(path).includes('filters=') && decodeURIComponent(path).includes('"field":"name"') && decodeURIComponent(path).includes('"value":"某某"'))).toBe(true);
    });
    fireEvent.click(screen.getByRole('button', { name: /导出全部/ }));
    await waitFor(() => {
      const paths = vi.mocked(download).mock.calls.map((call) => String(call[0]));
      expect(paths.some((path) => path === '/profit/excel/export/all')).toBe(true);
    });
  });
});
