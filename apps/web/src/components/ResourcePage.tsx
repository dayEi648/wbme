import { Button, Descriptions, Modal, Popconfirm, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useState, type ReactNode } from 'react';
import { DataTable, type DataColumn, type FilterField } from './DataTable';
import { ResourceFormModal, type FormField } from './ResourceFormModal';
import { useFeedback } from '../request/feedback';
import { http, type ApiService } from '../request/http';
import { formatDisplayValue } from './display-format';

interface CreateResourceConfig {
  title: string;
  fields: FormField[];
  endpoint?: string;
  transform?: (values: Record<string, unknown>) => Record<string, unknown>;
}

interface EditResourceConfig {
  title: string;
  fields: FormField[];
  endpoint?: (id: string | number) => string;
  transform?: (values: Record<string, unknown>, row: Record<string, unknown>) => Record<string, unknown>;
}

interface BatchDeleteConfig {
  endpoint: string;
  bodyKey: string;
  label?: string;
}

interface ResourceExportConfig {
  allEndpoint: string;
  filteredEndpoint?: string;
  filename: string;
  method?: 'GET' | 'POST';
}

export interface ResourcePageProps {
  title: string;
  description?: string;
  service: ApiService;
  endpoint: string;
  pageKey: string;
  columns: DataColumn[];
  filterFields?: FilterField[];
  create?: CreateResourceConfig;
  /** 声明后，行内“编辑”按钮会打开编辑表单；点击行始终仅查看详情。 */
  edit?: EditResourceConfig;
  batchDelete?: BatchDeleteConfig;
  /** 列表导出端点；由 DataTable 统一提供“全部 / 已筛选”范围。 */
  exportConfig?: ResourceExportConfig;
  actions?: ReactNode;
  rowActions?: (row: Record<string, unknown>) => ReactNode;
}

/**
 * 标准资源页：列表、通用表格能力、创建表单和确认式批量删除。
 *
 * 用于 REST 资源形态一致的业务页面；特殊状态机、审批和 Excel 场景由各自页面单独实现。
 */
export function ResourcePage({
  title,
  description,
  service,
  endpoint,
  pageKey,
  columns,
  filterFields,
  create,
  edit,
  batchDelete,
  exportConfig,
  actions,
  rowActions,
}: ResourcePageProps) {
  const feedback = useFeedback();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<Record<string, unknown> | null>(null);
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);
  const [version, setVersion] = useState(0);

  const submitCreate = async (values: Record<string, unknown>) => {
    if (!create) {
      return;
    }
    try {
      await http.post(create.endpoint ?? endpoint, create.transform?.(values) ?? values, { service });
      feedback.success(`${title}已创建`);
      setCreateOpen(false);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, `创建${title}失败`);
    }
  };

  const submitEdit = async (values: Record<string, unknown>) => {
    if (!edit || !editingRow) {
      return;
    }
    const id = editingRow.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      feedback.error(new Error('资源缺少可编辑的 ID'), `更新${title}失败`);
      return;
    }
    try {
      await http.put(edit.endpoint?.(id) ?? `${endpoint}/${id}`, edit.transform?.(values, editingRow) ?? values, { service });
      feedback.success(`${title}已更新`);
      setEditingRow(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, `更新${title}失败`);
    }
  };

  /** 单条删除仍复用后端批量接口，保持全有或全无与审计语义。 */
  const deleteRows = async (ids: Array<string | number>) => {
    if (!batchDelete) return;
    try {
      await http.delete(batchDelete.endpoint, { [batchDelete.bodyKey]: ids.map(Number) }, { service });
      feedback.success(ids.length === 1 ? `${title}已删除` : `${title}已删除`);
      setVersion((value) => value + 1);
      setDetailRow(null);
    } catch (error) {
      feedback.error(error, `删除${title}失败`);
    }
  };

  const renderRowActions = (row: Record<string, unknown>) => {
    const id = row.id;
    const actions = rowActions?.(row);
    const validId = typeof id === 'string' || typeof id === 'number';
    if (!edit && !batchDelete && !actions) return null;
    return <Space size="small">
      {edit && validId ? <Button size="small" onClick={() => setEditingRow(row)}>编辑</Button> : null}
      {batchDelete && validId ? (
        <Popconfirm title={`确认删除该${title}？`} description="删除后不可自动恢复，请确认已核对业务引用。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void deleteRows([id])}>
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      ) : null}
      {actions}
    </Space>;
  };

  const detailItems = columns
    .filter((column) => detailRow && column.key in detailRow)
    .map((column) => ({ key: column.key, label: column.title, children: <span style={{ whiteSpace: 'pre-wrap' }}>{formatDisplayValue(detailRow?.[column.key], column.key)}</span> }));

  return (
    <>
      <DataTable
        key={version}
        title={title}
        description={description}
        service={service}
        endpoint={endpoint}
        pageKey={pageKey}
        columns={columns}
        filterFields={filterFields}
        exportConfig={exportConfig}
        actions={<>{create ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建</Button> : null}{actions}</>}
        onRowClick={setDetailRow}
        rowActions={edit || batchDelete || rowActions ? renderRowActions : undefined}
        emptyAction={create ? { label: '去创建', onExecute: () => setCreateOpen(true) } : undefined}
        batchAction={batchDelete ? {
          label: batchDelete.label ?? '批量删除',
          danger: true,
          confirmationDescription: '删除后不可自动恢复，请确认已核对所有业务引用。',
          onExecute: deleteRows,
        } : undefined}
      />
      {create ? <ResourceFormModal title={`新建${title}`} open={createOpen} onCancel={() => setCreateOpen(false)} onSubmit={submitCreate} fields={create.fields} /> : null}
      {edit ? <ResourceFormModal title={edit.title} open={editingRow !== null} onCancel={() => setEditingRow(null)} onSubmit={submitEdit} fields={edit.fields} initialValues={editingRow ?? {}} /> : null}
      <Modal title={`${title}详情`} open={detailRow !== null} onCancel={() => setDetailRow(null)} footer={<Button onClick={() => setDetailRow(null)}>关闭</Button>} width={720}>
        <Descriptions bordered column={1} items={detailItems} />
      </Modal>
    </>
  );
}
