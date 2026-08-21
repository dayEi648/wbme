import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { AdvancedFilter } from './AdvancedFilter';
import { FeedbackProvider } from '../request/feedback';
import type { FilterConditionGroup, FilterField } from './advanced-filter';

const FIELDS: FilterField[] = [
  { key: 'name', title: '名称', type: 'text' },
  { key: 'status', title: '状态', type: 'enum', options: [{ label: '启用', value: 'ACTIVE' }] },
];

const EMPTY_TREE: FilterConditionGroup = { id: 'root', logic: 'AND', children: [] };

const renderPanel = (onApply = vi.fn()) => {
  render(
    <AntApp>
      <FeedbackProvider>
        <AdvancedFilter open fields={FIELDS} appliedTree={EMPTY_TREE} onApply={onApply} onCancel={vi.fn()} />
      </FeedbackProvider>
    </AntApp>,
  );
  return onApply;
};

describe('AdvancedFilter 冒烟（jsdom 为移动端断点 → Drawer 形态）', () => {
  it('打开后渲染标题与一条空条件行，取消不回写', () => {
    const onApply = renderPanel();
    expect(screen.getByText('高级筛选')).toBeTruthy();
    // 初始空条件行已选中第一个字段「名称」（createEmptyCondition 取 fields[0]）
    expect(screen.getByText('名称')).toBeTruthy();
    expect(screen.getByText('添加条件')).toBeTruthy();
    expect(screen.getByText('添加条件组')).toBeTruthy();
    fireEvent.click(screen.getByText('取 消'));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('空草稿点「确定」：回传剪枝后的空树', () => {
    const onApply = renderPanel();
    fireEvent.click(screen.getByText('确 定'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const applied = onApply.mock.calls[0]?.[0] as FilterConditionGroup;
    expect(applied.logic).toBe('AND');
    expect(applied.children).toEqual([]);
  });

  it('已填充文本条件点「确定」：回传保留该条件的树', () => {
    const onApply = renderPanel();
    fireEvent.change(screen.getByPlaceholderText('请输入'), { target: { value: '甲' } });
    fireEvent.click(screen.getByText('确 定'));
    const applied = onApply.mock.calls[0]?.[0] as FilterConditionGroup;
    expect(applied.children).toHaveLength(1);
    expect(applied.children[0]).toMatchObject({ field: 'name', operator: 'CONTAINS', value: '甲' });
  });
});
