import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined } from '@ant-design/icons';
import { Button, Card, Drawer, Grid, Modal, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { SortCondition } from './advanced-filter';

interface SortPanelProps {
  open: boolean;
  /** 可排序字段；数组顺序即优先级（第一项优先级最高）。 */
  sortableColumns: Array<{ key: string; title: string }>;
  /** 已生效的排序；打开时拷贝为草稿，取消/关闭不回写。 */
  appliedSorts: SortCondition[];
  onApply: (sorts: SortCondition[]) => void;
  onCancel: () => void;
}

/**
 * 多条件排序面板：桌面端居中 Modal、移动端右侧抽屉（与高级筛选一致）。
 *
 * 草稿按数组顺序表示优先级：越靠前优先级越高，用户可通过上移/下移调整；
 * 同一字段不允许重复出现，避免无意义的重复排序条件。
 */
export function SortPanel({ open, sortableColumns, appliedSorts, onApply, onCancel }: SortPanelProps) {
  const screens = Grid.useBreakpoint();
  const isDesktop = Boolean(screens.md);
  /** 编辑草稿；null 表示面板未打开。 */
  const [draft, setDraft] = useState<SortCondition[] | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(appliedSorts.map((sort) => ({ ...sort })));
  }, [open, appliedSorts]);

  const availableFields = sortableColumns.filter((column) => !draft?.some((sort) => sort.field === column.key));
  const fieldOptions = (currentField: string) => sortableColumns
    .filter((column) => column.key === currentField || availableFields.some((item) => item.key === column.key))
    .map((column) => ({ label: column.title, value: column.key }));

  const addSort = () => {
    const field = availableFields[0]?.key ?? sortableColumns[0]?.key;
    if (!field) {
      return;
    }
    setDraft((current) => [...(current ?? []), { field, direction: 'ASC' }]);
  };

  const removeSort = (index: number) => {
    setDraft((current) => (current ?? []).filter((_, itemIndex) => itemIndex !== index));
  };

  const moveSort = (index: number, offset: -1 | 1) => {
    setDraft((current) => {
      const next = [...(current ?? [])];
      const target = index + offset;
      if (target < 0 || target >= next.length) {
        return next;
      }
      const currentSort = next[index];
      const targetSort = next[target];
      if (!currentSort || !targetSort) {
        return next;
      }
      next[index] = targetSort;
      next[target] = currentSort;
      return next;
    });
  };

  const patchSort = (index: number, patch: Partial<SortCondition>) => {
    setDraft((current) => (current ?? []).map((sort, itemIndex) => (itemIndex === index ? { ...sort, ...patch } : sort)));
  };

  const handleReset = () => {
    setDraft([]);
  };

  const handleConfirm = () => {
    onApply(draft ?? []);
  };

  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <Button onClick={handleReset}>重置</Button>
      <Space>
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" onClick={handleConfirm}>确定</Button>
      </Space>
    </div>
  );

  const content = draft ? (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {draft.map((sort, index) => (
        <Card key={`${sort.field}-${index}`} size="small">
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Typography.Text strong>优先级 {index + 1}</Typography.Text>
              <Space size={0}>
                <Button type="text" size="small" icon={<ArrowUpOutlined />} aria-label="提高优先级" disabled={index === 0} onClick={() => moveSort(index, -1)} />
                <Button type="text" size="small" icon={<ArrowDownOutlined />} aria-label="降低优先级" disabled={index === draft.length - 1} onClick={() => moveSort(index, 1)} />
                <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="移除排序" onClick={() => removeSort(index)} />
              </Space>
            </Space>
            <Space.Compact style={{ width: '100%' }}>
              <Select
                aria-label="排序字段"
                showSearch
                optionFilterProp="label"
                style={{ flex: 1, minWidth: 0 }}
                value={sort.field}
                options={fieldOptions(sort.field)}
                onChange={(field: string) => patchSort(index, { field })}
              />
              <Select
                aria-label="排序方向"
                style={{ width: 120 }}
                value={sort.direction}
                options={[{ label: '升序', value: 'ASC' }, { label: '降序', value: 'DESC' }]}
                onChange={(direction: 'ASC' | 'DESC') => patchSort(index, { direction })}
              />
            </Space.Compact>
          </Space>
        </Card>
      ))}
      <Button type="dashed" block onClick={addSort} disabled={availableFields.length === 0}>
        添加排序字段
      </Button>
      <Typography.Text type="secondary">
        排序按优先级依次生效：先按“优先级 1”排序，相同值再按后续优先级排序。
      </Typography.Text>
    </Space>
  ) : null;

  return isDesktop ? (
    <Modal title="排序" open={open} onCancel={onCancel} width={560} footer={footer} maskClosable={false}>
      {content}
    </Modal>
  ) : (
    <Drawer title="排序" placement="right" open={open} onClose={onCancel} width="min(92vw, 420px)" footer={footer}>
      {content}
    </Drawer>
  );
}
