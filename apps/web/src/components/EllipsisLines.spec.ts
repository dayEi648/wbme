import { describe, expect, it } from 'vitest';
import { packLines } from './EllipsisLines';

describe('packLines（人员权限表格折行）', () => {
  it('行宽内逐项顿号连接', () => {
    expect(packLines(['资产系统', '人事系统'], 10)).toEqual(['资产系统、人事系统']);
  });

  it('超宽即换行', () => {
    expect(packLines(['资产系统', '人事系统', '财务系统'], 10)).toEqual(['资产系统、人事系统', '财务系统']);
  });

  it('按 Unicode 码点计宽', () => {
    expect(packLines(['固定资产维护（公司）', '消耗品申领（本人）'], 15)).toEqual(['固定资产维护（公司）', '消耗品申领（本人）']);
  });

  it('单项超宽时独占一行', () => {
    expect(packLines(['一个特别特别长的功能名称超出限制'], 10)).toEqual(['一个特别特别长的功能名称超出限制']);
  });

  it('忽略空白项；空列表返回空', () => {
    expect(packLines(['资产系统', '  ', ''], 10)).toEqual(['资产系统']);
    expect(packLines([], 10)).toEqual([]);
  });
});
