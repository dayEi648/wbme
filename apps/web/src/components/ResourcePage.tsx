import { Button, Descriptions, Modal, Popconfirm, Space, Typography } from 'antd';
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
  /** 打开新建表单时预填的字段值，例如由二维码携带的业务目标。 */
  initialValues?: Record<string, unknown>;
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
  /** 删除前引用预览端点（GET ?ids=）；服务端返回逐目标仍被引用的情况（主 PRD §2.6）。 */
  previewEndpoint?: string;
  /** 将预览记录与列表行格式化为「目标名称 + 引用明细」；缺省仅展示目标 ID。 */
  previewItem?: (previewItem: Record<string, unknown>, row: Record<string, unknown>) => { name: string; refs: string };
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
 * 组装删除预览的可读目标名称。
 *
 * @param previewItem 删除预览接口返回的目标及引用计数
 * @param row 当前列表中与目标 ID 对应的行
 * @param formatter 页面提供的引用信息格式化函数
 * @returns 供确认弹窗展示的目标名称与引用说明
 */
export function formatDeletePreviewItem(
  previewItem: Record<string, unknown>,
  row: Record<string, unknown> | undefined,
  formatter?: BatchDeleteConfig['previewItem'],
): { name: string; refs: string } {
  const formatted = formatter?.(previewItem, row ?? {});
  const rowName = typeof row?.name === 'string' && row.name.trim() ? row.name : undefined;
  return {
    name: rowName ?? formatted?.name ?? `#${String(previewItem.id ?? '')}`,
    refs: formatted?.refs ?? '',
  };
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
  /** 待确认删除的引用预览：{ ids, items }，items 为逐目标「名称 + 引用明细」。 */
  const [deletePreview, setDeletePreview] = useState<{ ids: Array<string | number>; items: Array<{ name: string; refs: string }> } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** 当前页行快照：删除预览时按 ID 匹配目标名称（引用预览接口只返回计数）。 */
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
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

  /**
   * 单条删除仍复用后端批量接口，保持全有或全无与审计语义。
   * 配置了 previewEndpoint 时先展示逐目标引用明细（主 PRD §2.6），确认后才执行删除。
   */
  const deleteRows = async (ids: Array<string | number>) => {
    if (!batchDelete) return;
    try {
      await http.delete(batchDelete.endpoint, { [batchDelete.bodyKey]: ids.map(Number) }, { service });
      feedback.success(`${title}已删除`);
      setVersion((value) => value + 1);
      setDetailRow(null);
    } catch (error) {
      feedback.error(error, `删除${title}失败`);
    }
  };

  /** 两段式删除第一段：请求逐目标引用预览并展示确认明细；无预览端点时直接删除。 */
  const requestDeletePreview = async (ids: Array<string | number>) => {
    if (!batchDelete) return;
    if (!batchDelete.previewEndpoint) {
      await deleteRows(ids);
      return;
    }
    setPreviewLoading(true);
    try {
      const result = await http.get<{ items?: Array<Record<string, unknown>> }>(
        `${batchDelete.previewEndpoint}?ids=${ids.map(String).join(',')}`,
        { service },
      );
      const items = (result.items ?? []).map((item) => {
        const row = rows.find((candidate) => String(candidate.id) === String(item.id));
        return formatDeletePreviewItem(item, row, batchDelete.previewItem);
      });
      setDeletePreview({ ids, items });
    } catch (error) {
      feedback.error(error, `获取${title}引用情况失败`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmDeletePreview = async () => {
    if (!deletePreview) return;
    await deleteRows(deletePreview.ids);
    setDeletePreview(null);
  };

  const renderRowActions = (row: Record<string, unknown>) => {
    const id = row.id;
    const actions = rowActions?.(row);
    const validId = typeof id === 'string' || typeof id === 'number';
    if (!edit && !batchDelete && !actions) return null;
    return <Space size="small">
      {edit && validId ? <Button size="small" onClick={() => setEditingRow(row)}>编辑</Button> : null}
      {batchDelete && validId ? (
        <Popconfirm title={`确认删除该${title}？`} description={batchDelete.previewEndpoint ? '删除前将核对业务引用明细。' : '删除后不可自动恢复，请确认已核对业务引用。'} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void requestDeletePreview([id])}>
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
        actions={<>{create ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{create.title}</Button> : null}{actions}</>}
        onRowClick={setDetailRow}
        onRowsLoaded={setRows}
        rowActions={edit || batchDelete || rowActions ? renderRowActions : undefined}
        emptyAction={create ? { label: '去创建', onExecute: () => setCreateOpen(true) } : undefined}
        batchAction={batchDelete ? {
          label: batchDelete.label ?? '批量删除',
          danger: true,
          confirmationDescription: batchDelete.previewEndpoint ? '删除前将逐项核对引用明细并确认。' : '删除后不可自动恢复，请确认已核对所有业务引用。',
          onExecute: requestDeletePreview,
        } : undefined}
      />
      {create ? <ResourceFormModal title={create.title} open={createOpen} onCancel={() => setCreateOpen(false)} onSubmit={submitCreate} fields={create.fields} initialValues={create.initialValues} /> : null}
      {edit ? <ResourceFormModal title={edit.title} open={editingRow !== null} onCancel={() => setEditingRow(null)} onSubmit={submitEdit} fields={edit.fields} initialValues={editingRow ?? {}} /> : null}
      <Modal title={`${title}详情`} open={detailRow !== null} onCancel={() => setDetailRow(null)} footer={<Button onClick={() => setDetailRow(null)}>关闭</Button>} width={720}>
        <Descriptions bordered column={1} items={detailItems} />
      </Modal>
      <Modal
        title="确认删除"
        open={deletePreview !== null}
        onCancel={() => setDeletePreview(null)}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: previewLoading }}
        onOk={() => void confirmDeletePreview()}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text>以下目标仍被业务引用，删除后按删除前名称快照展示既有业务与历史记录：</Typography.Text>
          {deletePreview?.items.map((item, index) => (
            <div key={index} style={{ background: 'rgba(0,0,0,0.02)', padding: '8px 12px', borderRadius: 6 }}>
              <Typography.Text strong>{item.name}</Typography.Text>
              <div><Typography.Text type="secondary">{item.refs}</Typography.Text></div>
            </div>
          ))}
        </Space>
      </Modal>
    </>
  );
}
