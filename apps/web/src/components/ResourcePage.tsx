import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useState, type ReactNode } from 'react';
import { DataTable, type DataColumn, type FilterField } from './DataTable';
import { ResourceFormModal, type FormField } from './ResourceFormModal';
import { useFeedback } from '../request/feedback';
import { http, type ApiService } from '../request/http';

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
  /** 声明后，点击行会打开编辑表单；复杂状态机页面不使用此通用入口。 */
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
        onRowClick={edit ? setEditingRow : undefined}
        rowActions={rowActions}
        batchAction={batchDelete ? {
          label: batchDelete.label ?? '批量删除',
          danger: true,
          onExecute: async (ids) => {
            await http.delete(batchDelete.endpoint, { [batchDelete.bodyKey]: ids.map(Number) }, { service });
          },
        } : undefined}
      />
      {create ? <ResourceFormModal title={`新建${title}`} open={createOpen} onCancel={() => setCreateOpen(false)} onSubmit={submitCreate} fields={create.fields} /> : null}
      {edit ? <ResourceFormModal title={edit.title} open={editingRow !== null} onCancel={() => setEditingRow(null)} onSubmit={submitEdit} fields={edit.fields} initialValues={editingRow ?? {}} /> : null}
    </>
  );
}
