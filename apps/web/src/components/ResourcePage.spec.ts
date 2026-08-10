import { describe, expect, it } from 'vitest';
import { formatDeletePreviewItem } from './ResourcePage';

describe('删除引用预览', () => {
  it('优先展示当前列表中的业务名称，而不是目标 ID', () => {
    expect(formatDeletePreviewItem(
      { id: 12, assetCount: 3 },
      { id: 12, name: '工程部' },
      (item) => ({ name: `#${String(item.id)}`, refs: `现存资产 ${String(item.assetCount)} 个` }),
    )).toEqual({ name: '工程部', refs: '现存资产 3 个' });
  });

  it('列表行缺失时保留页面提供的目标名称回退', () => {
    expect(formatDeletePreviewItem(
      { id: 12 },
      undefined,
      (item) => ({ name: `#${String(item.id)}`, refs: '' }),
    )).toEqual({ name: '#12', refs: '' });
  });
});
