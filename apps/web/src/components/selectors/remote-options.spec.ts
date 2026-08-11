import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../request/http', () => ({
  http: { get: vi.fn() },
}));

import { http } from '../../request/http';
import { loadRemoteOptions, resolveRemoteEndpoint, type RemoteOptionSource } from './remote-options';

const get = vi.mocked(http.get);

describe('远程选择器数据源', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('缺少上游 id 时不构造请求，合法 id 才生成受控端点', () => {
    const source: RemoteOptionSource = {
      service: 'asset',
      endpoint: '/fallback',
      resolveEndpoint: (value) => typeof value === 'number' && value > 0 ? `/items?requestId=${value}` : null,
    };
    expect(resolveRemoteEndpoint(source, undefined)).toBeNull();
    expect(resolveRemoteEndpoint(source, 42)).toBe('/items?requestId=42');
  });

  it('按关联值过滤并按 value 去重，避免代领申请出现重复选项', async () => {
    get.mockResolvedValue({
      data: [
        { agentRequestId: 7, name: '第一个' },
        { agentRequestId: 7, name: '重复项' },
        { agentRequestId: 8, name: '其它申请' },
      ],
      pagination: { totalPages: 1 },
    });
    const source: RemoteOptionSource = {
      service: 'asset',
      endpoint: '/disposals?tab=PENDING',
      uniqueByValue: true,
      filterRows: (row, context) => row.agentRequestId === context,
      mapOption: (row) => ({ label: String(row.name), value: Number(row.agentRequestId) }),
    };

    await expect(loadRemoteOptions(source, 7)).resolves.toEqual([{ label: '第一个', value: 7 }]);
    expect(get).toHaveBeenCalledWith('/disposals?tab=PENDING&page=1&pageSize=100', { service: 'asset', active: true });
  });
});
