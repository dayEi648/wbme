import { Button, Card, Drawer, Input, InputNumber, Popconfirm, Select, Space, Table, Typography, Upload, theme, type UploadFile } from 'antd';
import { DownloadOutlined, ExportOutlined, ImportOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppShell, type NavigationItem } from '../../components/AppShell';
import { DataTable } from '../../components/DataTable';
import { JsonDetails } from '../../components/JsonDetails';
import { ResourcePage } from '../../components/ResourcePage';
import { ResourceFormModal, type FormField } from '../../components/ResourceFormModal';
import { SystemHome } from '../../components/SystemHome';
import { useFeedback } from '../../request/feedback';
import { download, http, upload } from '../../request/http';
import { useSession } from '../../request/session';

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 将十进制比率精确显示为两位百分比，不经过 JavaScript 浮点数。 */
function formatPercentage(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return text;
  const [, sign, integer, fraction = ''] = match;
  const scale = 10n ** BigInt(fraction.length);
  const source = BigInt(`${integer}${fraction}`);
  const scaled = (source * 10_000n + scale / 2n) / scale;
  const whole = scaled / 100n;
  const decimal = String(scaled % 100n).padStart(2, '0');
  return `${sign}${whole}.${decimal}%`;
}

const NAVIGATION: NavigationItem[] = [
  { key: 'projects', label: '工程合同', path: '/fin/projects', permission: 'finance_view' },
  { key: 'profit', label: '利润分析', path: '/fin/profit', permission: 'finance_view' },
  { key: 'excel', label: 'Excel 导入导出', path: '/fin/excel', permission: 'finance_maintain' },
  { key: 'operations', label: '项目操作记录', path: '/fin/operations', permission: 'finance_view' },
  { key: 'config', label: '财务配置', path: '/fin/config', permission: 'finance_config' },
];

const PROJECT_COLUMNS = [
  { key: 'id', title: 'ID', fixed: 'left' as const },
  { key: 'name', title: '项目名称' },
  { key: 'year', title: '年度' },
  { key: 'partyA', title: '甲方' },
  { key: 'contractAmount', title: '合同金额' },
  { key: 'tentativeAuditedAmount', title: '暂定/审定金额' },
  { key: 'receivedAmount', title: '累计收款' },
  { key: 'updatedAt', title: '更新时间' },
];

const PROJECT_FORM_FIELDS: FormField[] = [
  { key: 'name', label: '项目名称', required: true, maxLength: 200 },
  { key: 'year', label: '年度', type: 'number', required: true },
  { key: 'partyA', label: '甲方', maxLength: 200 },
  { key: 'generalContractor', label: '总包方', maxLength: 200 },
  { key: 'managementFee', label: '管理费', maxLength: 200 },
  { key: 'contractStartDate', label: '合同开始日期', type: 'date' },
  { key: 'contractEndDate', label: '合同完工日期', type: 'date' },
  { key: 'contractAmount', label: '合同金额', type: 'number' },
  { key: 'paymentNode', label: '主合同付款节点', type: 'textarea', maxLength: 500 },
  { key: 'tentativeAuditedAmount', label: '暂定/审定金额', type: 'number' },
  { key: 'settlement', label: '分包结算', type: 'number' },
  { key: 'miscExpense', label: '零星费用', type: 'number' },
  { key: 'regionId', label: '地区 ID', type: 'number' },
  { key: 'progressId', label: '项目进度 ID', type: 'number' },
  { key: 'bizCategoryId', label: '业务分类 ID', type: 'number' },
  { key: 'remark', label: '项目备注', type: 'textarea', maxLength: 1000 },
];

const MONEY_FIELDS = new Set(['contractAmount', 'tentativeAuditedAmount', 'settlement', 'miscExpense']);

interface PreviewChoice {
  rowNumber: number;
  name: string;
  year: number | null;
  bizCategory: string | null;
  projectId: number;
  dataRevision: number;
  dataLossWarning: boolean;
}

interface ImportPreview extends RecordValue {
  summary?: RecordValue;
  created?: RecordValue[];
  pendingChoice?: PreviewChoice[];
  conflicts?: RecordValue[];
  errors?: RecordValue[];
}

/** 财务系统路由容器。 */
export default function FinPage() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] ?? '';
  const body = useMemo(() => {
    switch (section) {
      case 'projects':
        return <Projects />;
      case 'profit':
        return <ProfitAnalysis />;
      case 'excel':
        return <ExcelImportExport />;
      case 'operations':
        return <DataTable title="项目操作记录" description="记录财务项目的新增、修改、删除与金额明细变更。" service="fin" endpoint="/project-operations" pageKey="fin-project-operations" columns={[{ key: 'id', title: 'ID', fixed: 'left' as const }, { key: 'projectName', title: '项目' }, { key: 'actionType', title: '操作' }, { key: 'operatorName', title: '操作者' }, { key: 'createdAt', title: '时间' }]} filterFields={[{ key: 'projectId', title: '项目 ID', type: 'number' }]} />;
      case 'config':
        return <FinanceConfig />;
      default:
        return <SystemHome systemName="财务系统" welcome="维护工程合同、金额明细、利润分析和财务配置。" items={NAVIGATION} />;
    }
  }, [section]);
  return <AppShell systemName="财务系统" homePath="/fin" items={NAVIGATION}>{body}</AppShell>;
}

function Projects() {
  const { can } = useSession();
  const canMaintain = can('finance_maintain');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [deletedOpen, setDeletedOpen] = useState(false);
  return <>
<ResourcePage title="工程合同" description="项目名称和年度构成业务唯一键；金额使用精确十进制字符串。点击行可编辑完整合同资料。" service="fin" endpoint="/projects" pageKey="fin-projects" columns={PROJECT_COLUMNS} filterFields={[{ key: 'name', title: '项目名称', type: 'text' }, { key: 'partyA', title: '甲方', type: 'text' }, { key: 'year', title: '年度', type: 'number' }, { key: 'regionId', title: '地区 ID', type: 'number' }, { key: 'progressId', title: '进度 ID', type: 'number' }]} create={canMaintain ? { title: '新建工程合同', fields: PROJECT_FORM_FIELDS } : undefined} edit={canMaintain ? { title: '编辑工程合同', endpoint: (id) => `/projects/${id}`, fields: PROJECT_FORM_FIELDS } : undefined} exportConfig={{ allEndpoint: '/profit/excel/export/all', filteredEndpoint: '/profit/excel/export/filtered', filename: 'profit-projects.xlsx' }} batchDelete={canMaintain ? { endpoint: '/projects/batch', bodyKey: 'ids' } : undefined} actions={canMaintain ? <Button onClick={() => setDeletedOpen(true)}>已删除项目</Button> : undefined} rowActions={(row) => <Button size="small" onClick={() => setDetailId(Number(row.id))}>金额明细</Button>} />
    {detailId !== null ? <ProjectDetails projectId={detailId} canMaintain={canMaintain} onClose={() => setDetailId(null)} /> : null}
    <Drawer title="已删除项目" open={deletedOpen} onClose={() => setDeletedOpen(false)} width="min(92vw, 1100px)"><DataTable title="已删除项目" description="软删除项目保留原 ID、业务键及操作历史；仅支持勾选后批量恢复。" service="fin" endpoint="/projects?view=deleted" pageKey="fin-deleted-projects" columns={PROJECT_COLUMNS} batchAction={{ label: '批量恢复', onExecute: async (ids) => { await http.put('/projects/deleted/restore', { ids: ids.map(Number) }, { service: 'fin' }); } }} /></Drawer>
  </>;
}

type DetailKind = 'invoice' | 'receipt' | 'subcontract-payment';
interface DetailItem extends RecordValue { id: number; amount: string; occurredDate?: string | null; remark?: string | null; }

/** 项目详情中的三类金额明细维护；每次仅变更一条，删除有明确二次确认。 */
function ProjectDetails({ projectId, canMaintain, onClose }: { projectId: number; canMaintain: boolean; onClose: () => void }) {
  const feedback = useFeedback();
  const [detail, setDetail] = useState<RecordValue | null>(null);
  const [editing, setEditing] = useState<{ kind: DetailKind; item?: DetailItem } | null>(null);
  const load = async () => {
    try {
      setDetail(await http.get<RecordValue>(`/projects/${projectId}`, { service: 'fin', active: true }));
    } catch (error) {
      feedback.error(error, '项目详情加载失败');
    }
  };
  useEffect(() => { void load(); }, [projectId]);
  const save = async (values: RecordValue) => {
    if (!editing) return;
    try {
      const body = { item: { amount: String(values.amount), occurredDate: values.occurredDate || undefined, remark: values.remark || undefined } };
      if (editing.item) await http.put(`/projects/${projectId}/details/${editing.kind}/${editing.item.id}`, body, { service: 'fin' });
      else await http.post(`/projects/${projectId}/details/${editing.kind}`, body, { service: 'fin' });
      feedback.success(editing.item ? '金额明细已更新' : '金额明细已新增');
      setEditing(null);
      await load();
    } catch (error) {
      feedback.error(error, '保存金额明细失败');
    }
  };
  const remove = async (kind: DetailKind, item: DetailItem) => {
    try {
      await http.delete(`/projects/${projectId}/details/${kind}/${item.id}`, undefined, { service: 'fin' });
      feedback.success('金额明细已删除');
      await load();
    } catch (error) {
      feedback.error(error, '删除金额明细失败');
    }
  };
  const detailRows = (key: 'invoices' | 'receipts' | 'subcontractPayments'): DetailItem[] => {
    const details = detail?.details;
    return isRecord(details) && Array.isArray(details[key]) ? details[key].filter((item): item is DetailItem => isRecord(item) && typeof item.id === 'number' && typeof item.amount === 'string') : [];
  };
  const table = (title: string, kind: DetailKind, rows: DetailItem[]) => <Card key={kind} size="small" title={title} extra={canMaintain ? <Button size="small" onClick={() => setEditing({ kind })}>新增</Button> : null}><Table<DetailItem> size="small" rowKey="id" pagination={false} dataSource={rows} locale={{ emptyText: '暂无明细' }} columns={[{ key: 'amount', title: '金额', dataIndex: 'amount' }, { key: 'occurredDate', title: '日期', dataIndex: 'occurredDate' }, { key: 'remark', title: '备注', dataIndex: 'remark' }, ...(canMaintain ? [{ key: 'actions', title: '操作', render: (_: unknown, item: DetailItem) => <Space size="small"><Button size="small" onClick={() => setEditing({ kind, item })}>编辑</Button><Popconfirm title="确认删除这条金额明细？删除不可恢复。" onConfirm={() => void remove(kind, item)}><Button size="small" danger>删除</Button></Popconfirm></Space> }] : [])]} /></Card>;
  return <Drawer title="项目详情与金额明细" open onClose={onClose} width={860}>{detail ? <Space direction="vertical" size="large" style={{ width: '100%' }}><Card title="项目资料" size="small">{JSON.stringify(detail.project ?? {})}</Card><Card title="自动计算" size="small">{JSON.stringify(detail.auto ?? {})}</Card>{table('开票金额', 'invoice', detailRows('invoices'))}{table('已收回款', 'receipt', detailRows('receipts'))}{table('已付分包款', 'subcontract-payment', detailRows('subcontractPayments'))}</Space> : <Typography.Text>正在加载...</Typography.Text>}<ResourceFormModal title={editing?.item ? '编辑金额明细' : '新增金额明细'} open={editing !== null} onCancel={() => setEditing(null)} onSubmit={save} initialValues={editing?.item ?? {}} fields={[{ key: 'amount', label: '金额', type: 'number', required: true }, { key: 'occurredDate', label: '日期', type: 'date' }, { key: 'remark', label: '备注', type: 'textarea', maxLength: 200 }]} /></Drawer>;
}

function ProfitAnalysis() {
  const feedback = useFeedback();
  const { can } = useSession();
  const { token } = theme.useToken();
  const [rows, setRows] = useState<RecordValue[]>([]);
  const [totals, setTotals] = useState<RecordValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [moneyDrafts, setMoneyDrafts] = useState<Record<string, string>>({});
  const canEdit = can('finance_maintain');

  const load = async () => {
    setLoading(true);
    try {
      const [list, total] = await Promise.all([
        http.get<{ data?: RecordValue[]; items?: RecordValue[] }>('/profit/projects?page=1&pageSize=100', { service: 'fin', active: true }),
        http.get<RecordValue>('/profit/totals', { service: 'fin', active: true }),
      ]);
      setRows(list.data ?? list.items ?? []);
      setTotals(total);
    } catch (error) {
      feedback.error(error, '利润分析加载失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []); // 首次加载；保存后在本地精确回填。

  const saveCell = async (row: RecordValue, field: string, value: string): Promise<boolean> => {
    const projectId = Number(row.id);
    if (!Number.isInteger(projectId)) return false;
    try {
      const result = await http.put<{ value: unknown; auto: RecordValue; dataRevision: number }>('/profit/cells', { projectId, field, value }, { service: 'fin' });
      setRows((current) => current.map((item) => Number(item.id) === projectId ? { ...item, [field]: result.value, ...result.auto, dataRevision: result.dataRevision } : item));
      feedback.success('已保存');
      return true;
    } catch (error) {
      feedback.error(error, '单元格保存失败');
      return false;
    }
  };

  /** 金额草稿始终保持十进制字符串；提交发生于失焦，避免每个字符都发起写请求。 */
  const commitMoneyCell = async (row: RecordValue, field: string, original: string, draftKey: string) => {
    const value = moneyDrafts[draftKey] ?? original;
    if (value === original) {
      setMoneyDrafts((current) => {
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
      return;
    }
    if (await saveCell(row, field, value)) {
      setMoneyDrafts((current) => {
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
    }
  };

  const editableFields = new Set(['name', 'year', 'partyA', 'generalContractor', 'managementFee', 'contractAmount', 'tentativeAuditedAmount', 'settlement', 'miscExpense', 'remark']);
  const renderCell = (field: string) => (value: unknown, row: RecordValue) => {
    const text = value === null || value === undefined ? '' : String(value);
    if (!canEdit || !editableFields.has(field)) return text || '—';
    if (MONEY_FIELDS.has(field)) {
      const draftKey = `${String(row.id)}:${field}`;
      return <InputNumber<string> stringMode value={moneyDrafts[draftKey] ?? text} aria-label={`${String(row.name ?? '项目')} ${field}`} style={{ width: '100%' }} onChange={(nextValue) => setMoneyDrafts((current) => ({ ...current, [draftKey]: nextValue ?? '' }))} onPressEnter={(event) => event.currentTarget.blur()} onBlur={() => void commitMoneyCell(row, field, text, draftKey)} />;
    }
    return <Input defaultValue={text} aria-label={`${String(row.name ?? '项目')} ${field}`} onPressEnter={(event) => void saveCell(row, field, event.currentTarget.value)} onBlur={(event) => void saveCell(row, field, event.currentTarget.value)} />;
  };
  const negative = (value: unknown) => <span style={String(value).startsWith('-') ? { color: token.colorError } : undefined}>{value === null || value === undefined ? '—' : String(value)}</span>;

  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <div><Typography.Title level={3}>利润分析</Typography.Title><Typography.Paragraph type="secondary">桌面端可直接编辑单个业务单元格并即时保存；自动计算列不可编辑。移动端复用同一保存接口。</Typography.Paragraph></div>
    <Card loading={loading} styles={{ body: { padding: 0 } }}>
      <Table<RecordValue> rowKey={(row) => String(row.id)} dataSource={rows} pagination={false} scroll={{ x: 'max-content' }} columns={[
        { key: 'name', title: '项目名称', fixed: 'left', width: 220, render: renderCell('name') },
        { key: 'year', title: '年度', width: 110, render: renderCell('year') },
        { key: 'partyA', title: '甲方', width: 200, render: renderCell('partyA') },
        { key: 'contractAmount', title: '合同金额', width: 160, render: renderCell('contractAmount') },
        { key: 'tentativeAuditedAmount', title: '暂定/审定金额', width: 180, render: renderCell('tentativeAuditedAmount') },
        { key: 'invoicedAmount', title: '累计开票', width: 140, render: (value) => String(value ?? '0') },
        { key: 'receivedAmount', title: '累计收款', width: 140, render: (value) => String(value ?? '0') },
        { key: 'remainingInvoiceAmount', title: '剩余未开票', width: 150, render: negative },
        { key: 'remainingReceiptAmount', title: '剩余未收款', width: 150, render: negative },
        { key: 'grossMargin', title: '毛利率', width: 120, render: formatPercentage },
      ]} />
    </Card>
    {totals ? <Card title="当前筛选范围汇总"><Space wrap>{Object.entries(totals).map(([key, value]) => <Typography.Text key={key}>{key}：{String(value ?? '—')}</Typography.Text>)}</Space></Card> : null}
  </Space>;
}

function ExcelImportExport() {
  const feedback = useFeedback();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, 'OVERWRITE' | 'SKIP'>>({});
  const [loading, setLoading] = useState(false);
  const selectFile = (uploadFile: UploadFile) => {
    const original = uploadFile.originFileObj;
    if (!original) return false;
    if (original.size > 20 * 1024 * 1024) {
      feedback.error(new Error('文件过大'), '单个导入文件不能超过 20 MiB');
      return Upload.LIST_IGNORE;
    }
    setFile(original);
    setPreview(null);
    setChoices({});
    return false;
  };
  const previewFile = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const nextPreview = await upload<ImportPreview>('/profit/excel/import/preview', form, { service: 'fin' });
      setPreview(nextPreview);
      setChoices(Object.fromEntries((nextPreview.pendingChoice ?? []).map((item) => [item.rowNumber, 'SKIP'])));
      feedback.success('导入预览已生成');
    } catch (error) {
      feedback.error(error, '导入预览失败');
    } finally {
      setLoading(false);
    }
  };
  const confirmFile = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('choices', JSON.stringify(importChoices(preview, choices)));
      await upload('/profit/excel/import/confirm', form, { service: 'fin', idempotencyKey: crypto.randomUUID() });
      feedback.success('Excel 导入已完成');
      setPreview(null);
      setFile(null);
      setChoices({});
    } catch (error) {
      feedback.error(error, 'Excel 导入确认失败');
    } finally {
      setLoading(false);
    }
  };
  const exportFile = async (scope: 'all' | 'filtered') => {
    try {
      const blob = await download(`/profit/excel/export/${scope}`, { service: 'fin', active: true });
      triggerDownload(blob, `profit-${scope}.xlsx`);
    } catch (error) {
      feedback.error(error, 'Excel 导出失败');
    }
  };
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <div><Typography.Title level={3}>利润分析 Excel 导入导出</Typography.Title><Typography.Paragraph type="secondary">仅接受服务端导出的 V2 模板；预览与确认均在当前请求中限时处理，不留存原文件。</Typography.Paragraph></div>
    <Card title="导入">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Upload accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" maxCount={1} beforeUpload={selectFile} onRemove={() => { setFile(null); setPreview(null); setChoices({}); }}>
          <Button icon={<ImportOutlined />}>选择 Excel 文件</Button>
        </Upload>
        <Space wrap><Button type="primary" disabled={!file} loading={loading} onClick={() => void previewFile()}>生成预览</Button><Button disabled={!preview || loading} onClick={() => void confirmFile()}>确认导入</Button></Space>
        {preview ? <ImportPreviewCard preview={preview} choices={choices} onChoiceChange={(rowNumber, decision) => setChoices((current) => ({ ...current, [rowNumber]: decision }))} /> : null}
      </Space>
    </Card>
    <Card title="导出"><Space wrap><Button icon={<DownloadOutlined />} onClick={() => void exportFile('all')}>导出全部</Button><Button icon={<ExportOutlined />} onClick={() => void exportFile('filtered')}>导出已筛选</Button></Space></Card>
  </Space>;
}

function FinanceConfig() {
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <JsonDetails title="财务运行参数" service="fin" endpoint="/finance-settings" description="财务系统运行配置即时生效。" />
    <ResourcePage title="财务字典" service="fin" endpoint="/finance-dict-items" pageKey="fin-dicts" columns={[{ key: 'id', title: 'ID', fixed: 'left' as const }, { key: 'dictType', title: '类型' }, { key: 'name', title: '名称' }, { key: 'semantic', title: '金额语义' }, { key: 'status', title: '状态' }]} filterFields={[{ key: 'dictType', title: '类型', type: 'enum', options: [{ label: '项目进度', value: 'PROGRESS' }, { label: '资料齐全度', value: 'COMPLETENESS' }, { label: '业务分类', value: 'BIZ_CATEGORY' }, { label: '地区', value: 'REGION' }] }]} create={{ title: '新建财务字典项', endpoint: '/finance-dict-items', fields: [{ key: 'dictType', label: '字典类型', type: 'select', required: true, options: [{ label: '项目进度', value: 'PROGRESS' }, { label: '资料齐全度', value: 'COMPLETENESS' }, { label: '业务分类', value: 'BIZ_CATEGORY' }, { label: '地区', value: 'REGION' }] }, { key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'semantic', label: '金额语义', type: 'select', options: [{ label: '暂定', value: 'TENTATIVE' }, { label: '审定', value: 'AUDITED' }] }, { key: 'sort', label: '排序', type: 'number' }] }} edit={{ title: '编辑财务字典项', endpoint: (id) => `/finance-dict-items/${id}`, fields: [{ key: 'name', label: '名称', maxLength: 100 }, { key: 'semantic', label: '金额语义', type: 'select', options: [{ label: '暂定', value: 'TENTATIVE' }, { label: '审定', value: 'AUDITED' }] }, { key: 'sort', label: '排序', type: 'number' }, { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }] }} batchDelete={{ endpoint: '/finance-dict-items/batch', bodyKey: 'ids' }} />
  </Space>;
}

function ImportPreviewCard({ preview, choices, onChoiceChange }: { preview: ImportPreview; choices: Record<number, 'OVERWRITE' | 'SKIP'>; onChoiceChange: (rowNumber: number, decision: 'OVERWRITE' | 'SKIP') => void }) {
  const pending = preview.pendingChoice ?? [];
  return <Card size="small" title="导入预览">
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {preview.summary ? <Typography.Text>汇总：{Object.entries(preview.summary).map(([key, value]) => `${key} ${String(value)}`).join('，')}</Typography.Text> : null}
      {pending.length > 0 ? <Table<PreviewChoice> size="small" rowKey="rowNumber" pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条待选择记录` }} dataSource={pending} columns={[
        { key: 'rowNumber', title: '行', dataIndex: 'rowNumber', width: 70 },
        { key: 'name', title: '项目', dataIndex: 'name' },
        { key: 'year', title: '年度', dataIndex: 'year', width: 100 },
        { key: 'warning', title: '提示', render: (_, row) => row.dataLossWarning ? '覆盖会清空原明细的日期/备注' : '—' },
        { key: 'decision', title: '处理', render: (_, row) => <Select value={choices[row.rowNumber] ?? 'SKIP'} style={{ minWidth: 120 }} options={[{ label: '跳过', value: 'SKIP' }, { label: '覆盖', value: 'OVERWRITE' }]} onChange={(value: 'OVERWRITE' | 'SKIP') => onChoiceChange(row.rowNumber, value)} /> },
      ]} /> : null}
      {(preview.created?.length ?? 0) > 0 ? <Typography.Text type="success">将新增 {preview.created?.length} 行。</Typography.Text> : null}
      {(preview.conflicts?.length ?? 0) > 0 ? <Typography.Text type="warning">存在 {preview.conflicts?.length} 行冲突，不能导入。</Typography.Text> : null}
      {(preview.errors?.length ?? 0) > 0 ? <Typography.Text type="danger">存在 {preview.errors?.length} 行校验错误，不能导入。</Typography.Text> : null}
    </Space>
  </Card>;
}

function importChoices(preview: ImportPreview | null, choices: Record<number, 'OVERWRITE' | 'SKIP'>): Array<{ rowNumber: number; decision: 'OVERWRITE' | 'SKIP'; projectId: number; dataRevision: number }> {
  return (preview?.pendingChoice ?? []).map((item) => ({
    rowNumber: item.rowNumber,
    decision: choices[item.rowNumber] ?? 'SKIP',
    projectId: item.projectId,
    dataRevision: item.dataRevision,
  }));
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
