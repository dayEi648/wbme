import { Button, Card, Checkbox, Descriptions, Drawer, Input, InputNumber, Modal, Pagination, Popconfirm, Select, Space, Table, Tabs, Typography, Upload, theme, type UploadFile } from 'antd';
import { DownloadOutlined, ExportOutlined, ImportOutlined, RedoOutlined, UndoOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppShell, type NavigationItem } from '../../components/AppShell';
import { DataTable } from '../../components/DataTable';
import { JsonDetails } from '../../components/JsonDetails';
import { ResourcePage } from '../../components/ResourcePage';
import { ResourceFormModal, type FormField } from '../../components/ResourceFormModal';
import { SystemHome } from '../../components/SystemHome';
import { formatDisplayValue, formatMoney } from '../../components/display-format';
import { financeDictSource, finProjectsSource, RemoteSelect } from '../../components/selectors';
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
  { key: 'projects', label: '工程合同', path: '/fin/projects', permission: 'finance_view', group: '业务' },
  { key: 'profit', label: '利润分析', path: '/fin/profit', permission: 'finance_view', group: '业务' },
  { key: 'operations', label: '项目操作记录', path: '/fin/operations', permission: 'finance_view', group: '业务' },
  { key: 'config', label: '系统设置', path: '/fin/config', permission: 'finance_config' },
];

/**
 * 判断当前会话能否挂载利润分析组件。
 *
 * @param can 当前会话的功能权限判断函数
 * @returns 具备利润分析读取权限时返回 true
 */
export function canMountProfitAnalysis(can: (permission: string) => boolean): boolean {
  return can('finance_view');
}

const PROJECT_COLUMNS = [
  { key: 'name', title: '项目名称' },
  { key: 'year', title: '年度', type: 'number' as const },
  { key: 'partyA', title: '甲方' },
  // 金额为精确十进制字符串，显式声明 number 使等宽数字字体生效（L29）
  { key: 'contractAmount', title: '合同金额', type: 'number' as const },
  { key: 'tentativeAuditedAmount', title: '暂定/审定金额', type: 'number' as const },
  { key: 'totalReceived', title: '累计收款', type: 'number' as const },
  { key: 'updatedAt', title: '更新时间' },
];

const PROJECT_FORM_FIELDS: FormField[] = [
  { key: 'name', label: '项目名称', required: true, maxLength: 200, group: '基本信息', width: 'wide' },
  { key: 'year', label: '年度', type: 'number', required: true, group: '基本信息', width: 'narrow' },
  { key: 'partyA', label: '甲方', maxLength: 200, group: '基本信息' },
  { key: 'generalContractor', label: '总包方', maxLength: 200, group: '基本信息' },
  { key: 'managementFee', label: '管理费', maxLength: 200, group: '基本信息' },
  { key: 'subcontractors', label: '分包方', type: 'tags', group: '基本信息', maxLength: 200, placeholder: '输入分包方名称后按回车添加' },
  { key: 'contractStartDate', label: '合同开始日期', type: 'date', group: '合同信息' },
  { key: 'contractEndDate', label: '合同完工日期', type: 'date', group: '合同信息' },
  { key: 'contractAmount', label: '合同金额', type: 'number', group: '合同信息', width: 'narrow' },
  { key: 'paymentNode', label: '主合同付款节点', type: 'textarea', maxLength: 500, group: '合同信息' },
  { key: 'tentativeAuditedAmount', label: '暂定/审定金额', type: 'number', group: '财务信息', width: 'narrow' },
  { key: 'settlement', label: '分包结算', type: 'number', group: '财务信息', width: 'narrow' },
  { key: 'miscExpense', label: '零星费用', type: 'number', group: '财务信息', width: 'narrow' },
  { key: 'regionId', label: '地区', type: 'remote-select', remote: financeDictSource('REGION'), group: '分类与备注' },
  { key: 'progressId', label: '项目进度', type: 'remote-select', remote: financeDictSource('PROGRESS'), group: '分类与备注' },
  { key: 'bizCategoryId', label: '业务分类', type: 'remote-select', remote: financeDictSource('BIZ_CATEGORY'), group: '分类与备注' },
  { key: 'completenessDocs', label: '资料齐全度', type: 'remote-multi-select', remote: financeDictSource('COMPLETENESS'), group: '分类与备注' },
  { key: 'remark', label: '项目备注', type: 'textarea', maxLength: 1000, group: '分类与备注' },
];

const MONEY_FIELDS = new Set(['contractAmount', 'tentativeAuditedAmount', 'settlement', 'miscExpense']);

/** 利润分析筛选条件（fin PRD §4：按项目、年度、地区、业务分类和进度筛选）。 */
interface ProfitFilters {
  name?: string;
  year?: number;
  regionId?: number;
  bizCategoryId?: number;
  progressId?: number;
}

/** 撤销/重做条目：已保存成功的单字段编辑（字段、编辑前值、编辑后值）。 */
interface UndoEntry {
  projectId: number;
  rowName: string;
  field: string;
  before: string;
  after: string;
}

/** 撤销栈上限（fin PRD §4：最多保留最近 50 次）。 */
const UNDO_LIMIT = 50;

/** 可编辑字段集（fin PRD §4：项目名称只读；编辑范围自「主合同付款节点」起的非自动字段）。 */
const EDITABLE_FIELDS = new Set(['paymentNode', 'tentativeAuditedAmount', 'settlement', 'miscExpense', 'remark']);

/** 利润分析列（顺序即键盘导航的横向顺序；money/ratio/negative 用于统一展示格式化）。 */
interface ProfitColumn {
  key: string;
  title: string;
  width: number;
  money?: boolean;
  ratio?: boolean;
  negative?: boolean;
}

const PROFIT_COLUMNS: ProfitColumn[] = [
  { key: 'name', title: '项目名称', width: 200 },
  { key: 'year', title: '年度', width: 90 },
  { key: 'partyA', title: '甲方', width: 160 },
  { key: 'contractAmount', title: '合同金额', money: true, width: 140 },
  { key: 'paymentNode', title: '主合同付款节点', width: 220 },
  { key: 'tentativeAuditedAmount', title: '暂定/审定金额', money: true, width: 160 },
  { key: 'totalInvoiced', title: '累计开票', money: true, width: 130 },
  { key: 'totalReceived', title: '累计收款', money: true, width: 130 },
  { key: 'remainingUninvoiced', title: '剩余未开票', money: true, negative: true, width: 140 },
  { key: 'remainingUnreceived', title: '剩余未收款', money: true, negative: true, width: 140 },
  { key: 'settlement', title: '分包结算', money: true, width: 130 },
  { key: 'miscExpense', title: '零星费用', money: true, width: 130 },
  { key: 'remark', title: '备注', width: 200 },
  { key: 'grossMargin', title: '毛利率', ratio: true, width: 110 },
];

/** 可编辑列在 PROFIT_COLUMNS 中的下标（键盘横向移动只落在可编辑列）。 */
const EDITABLE_COL_INDEXES = PROFIT_COLUMNS.map((column, index) => (EDITABLE_FIELDS.has(column.key) ? index : -1)).filter((index) => index >= 0);

/** 筛选下拉数据源（模块级单例，避免每次渲染重新加载选项）。 */
const PROFIT_REGION_SOURCE = financeDictSource('REGION');
const PROFIT_CATEGORY_SOURCE = financeDictSource('BIZ_CATEGORY');
const PROFIT_PROGRESS_SOURCE = financeDictSource('PROGRESS');

/** 构建利润分析查询串（筛选 + 可选分页；空筛选返回空串）。 */
function buildProfitQuery(filters: ProfitFilters, page?: number, pageSize?: number): string {
  const params = new URLSearchParams();
  if (filters.name) params.set('name', filters.name);
  if (filters.year !== undefined) params.set('year', String(filters.year));
  if (filters.regionId !== undefined) params.set('regionId', String(filters.regionId));
  if (filters.bizCategoryId !== undefined) params.set('bizCategoryId', String(filters.bizCategoryId));
  if (filters.progressId !== undefined) params.set('progressId', String(filters.progressId));
  if (page !== undefined) params.set('page', String(page));
  if (pageSize !== undefined) params.set('pageSize', String(pageSize));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** 项目资料中文标签（金额列保持十进制字符串展示，列表内已格式化）。 */
const PROJECT_FIELD_LABELS: Readonly<Record<string, string>> = {
  id: '项目 ID',
  name: '项目名称',
  year: '年度',
  partyA: '甲方',
  generalContractor: '总包方',
  managementFee: '管理费',
  subcontractors: '分包方',
  completenessDocs: '资料齐全度',
  contractStartDate: '合同开始日期',
  contractEndDate: '合同完工日期',
  contractAmount: '合同金额',
  paymentNode: '主合同付款节点',
  tentativeAuditedAmount: '暂定/审定金额',
  settlement: '分包结算',
  miscExpense: '零星费用',
  regionName: '地区',
  progressName: '项目进度',
  bizCategoryName: '业务分类',
  remark: '项目备注',
  createdAt: '创建时间',
  updatedAt: '更新时间',
  deletedAt: '删除时间',
};

/** 自动计算中文标签（键名与后端 ProjectCalcResult 一致）。 */
const AUTO_FIELD_LABELS: Readonly<Record<string, string>> = {
  totalInvoiced: '累计开票',
  totalReceived: '累计收款',
  totalSubcontractPaid: '累计分包付款',
  remainingUninvoiced: '剩余未开票',
  remainingUnreceived: '剩余未收款',
  equity: '暂定保通权益',
  grossMargin: '毛利率',
  dataRevision: '数据版本',
};

const PROJECT_MONEY_KEYS = new Set(['contractAmount', 'tentativeAuditedAmount', 'settlement', 'miscExpense', 'totalInvoiced', 'totalReceived', 'totalSubcontractPaid', 'remainingUninvoiced', 'remainingUnreceived', 'equity']);

/** 项目资料/自动计算字段 → 中文标签展示（金额千分位、比率百分比）。 */
function detailItems(obj: RecordValue | null, labels: Readonly<Record<string, string>>, moneyKeys: Set<string>, ratioKeys: Set<string> = new Set()) {
  if (!obj) return [];
  return Object.entries(labels)
    .filter(([key]) => obj[key] !== undefined && obj[key] !== null)
    .map(([key, label]) => {
      const value = obj[key];
      let children: React.ReactNode = String(value);
      if (Array.isArray(value)) children = value.length === 0 ? '—' : value.map((item) => (isRecord(item) ? String(item.name ?? JSON.stringify(item)) : String(item))).join('、');
      else if (moneyKeys.has(key)) children = formatMoney(value);
      else if (ratioKeys.has(key)) children = formatPercentage(value);
      else if (typeof value === 'object') children = JSON.stringify(value);
      return { label, children };
    });
}

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
  const { can } = useSession();
  const section = pathname.split('/')[2] ?? '';
  const body = useMemo(() => {
    switch (section) {
      case 'projects':
        return <Projects />;
      case 'operations':
        return <ProjectOperations />;
      case 'config':
        return <FinanceConfig />;
      // 利润分析常驻渲染（见下方 display:none 容器），body 不再重复挂载，避免
      // 与 SystemHome 欢迎页叠放（M22 复核回归：缺该分支时 /fin/profit 命中 default）
      case 'profit':
        return null;
      default:
        return <SystemHome systemName="财务系统" welcome="维护工程合同、金额明细、利润分析和财务配置。" items={NAVIGATION} />;
    }
  }, [section]);
  return <AppShell systemName="财务系统" homePath="/fin" items={NAVIGATION}>
    {body}
    {/* 利润分析常驻渲染（M22 复核修复）：离开保护基于 location 变化检测，
        若组件随 section 切换卸载，卸载与导航发生在同一 commit，确认弹窗永远不出现；
        display:none 隐藏非当前页，组件保持挂载使保护对站内切换真实生效 */}
    {canMountProfitAnalysis(can) ? <div style={{ display: section === 'profit' ? undefined : 'none' }}><ProfitAnalysis /></div> : null}
  </AppShell>;
}

/** 工程合同：书签式「在册合同 / 已删除项目」两页签（禁止 Drawer 套 DataTable）。 */
function Projects() {
  const { can } = useSession();
  const canMaintain = can('finance_maintain');
  const feedback = useFeedback();
  const [detailId, setDetailId] = useState<number | null>(null);
  // 编辑走自定义弹窗（同 HR 部门模式）：资料齐全度库中为 [{id, name}] 快照，需映射为多选 id 数组回填
  const [editingRow, setEditingRow] = useState<RecordValue | null>(null);
  const [version, setVersion] = useState(0);
  const saveEdit = async (values: RecordValue) => {
    const id = editingRow?.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    try {
      await http.put(`/projects/${id}`, toProjectPayload(values), { service: 'fin' });
      feedback.success('工程合同已更新');
      setEditingRow(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '更新工程合同失败');
    }
  };
  return <>
    <Tabs items={[
      { key: 'active', label: '在册合同', children: <ResourcePage key={version} title="工程合同" service="fin" endpoint="/projects" pageKey="fin-projects" columns={PROJECT_COLUMNS} filterFields={[{ key: 'name', title: '项目名称', type: 'text' }, { key: 'partyA', title: '甲方', type: 'text' }, { key: 'year', title: '年度', type: 'number' }, { key: 'bizCategoryId', title: '业务分类', type: 'remote', remote: financeDictSource('BIZ_CATEGORY') }, { key: 'regionId', title: '地区', type: 'remote', remote: financeDictSource('REGION') }, { key: 'progressId', title: '项目进度', type: 'remote', remote: financeDictSource('PROGRESS') }]} create={canMaintain ? { title: '新建工程合同', fields: PROJECT_FORM_FIELDS, transform: toProjectPayload } : undefined} batchDelete={canMaintain ? { endpoint: '/projects/batch', bodyKey: 'ids' } : undefined} rowActions={(row) => <Space size="small">{canMaintain ? <Button size="small" onClick={() => setEditingRow(row)}>编辑</Button> : null}<Button size="small" onClick={() => setDetailId(Number(row.id))}>金额明细</Button></Space>} /> },
      { key: 'deleted', label: '已删除项目', children: <DataTable title="已删除项目" service="fin" endpoint="/projects?view=deleted" pageKey="fin-deleted-projects" columns={PROJECT_COLUMNS} batchAction={{ label: '批量恢复', onExecute: async (ids) => { await http.put('/projects/deleted/restore', { ids: ids.map(Number) }, { service: 'fin' }); } }} /> },
    ]} />
    {detailId !== null ? <ProjectDetails projectId={detailId} canMaintain={canMaintain} onClose={() => setDetailId(null)} /> : null}
    {canMaintain ? <ResourceFormModal title="编辑工程合同" open={editingRow !== null} onCancel={() => setEditingRow(null)} onSubmit={saveEdit} fields={PROJECT_FORM_FIELDS} initialValues={editingRow ? toProjectFormValues(editingRow) : {}} /> : null}
  </>;
}

/**
 * 表单值 → 项目提交体：资料齐全度多选控件提交 id 数组，转换为字典引用 [{id}]
 * （名称快照由服务端按字典表重写）；未触碰（undefined/null）则不携带该键，
 * 服务端按 PATCH 语义保留库中原值，显式空数组才清空。
 */
function toProjectPayload(values: RecordValue): RecordValue {
  const { completenessDocs, ...rest } = values;
  if (completenessDocs === undefined || completenessDocs === null) {
    return rest;
  }
  const ids = Array.isArray(completenessDocs) ? completenessDocs : [completenessDocs];
  return { ...rest, completenessDocs: ids.map((id) => ({ id: Number(id) })) };
}

/** 编辑表单回填：库中资料齐全度为 [{id, name}] 快照，多选控件需要 id 数组。 */
function toProjectFormValues(row: RecordValue): RecordValue {
  const docs = Array.isArray(row.completenessDocs) ? row.completenessDocs : [];
  return {
    ...row,
    completenessDocs: docs
      .map((doc) => (isRecord(doc) ? Number(doc.id) : Number(doc)))
      .filter((id) => Number.isInteger(id) && id > 0),
  };
}

type DetailKind = 'invoice' | 'receipt' | 'subcontract-payment';
interface DetailItem extends RecordValue { id: number; amount: string; occurredDate?: string | null; remark?: string | null; }

/** 操作记录动作中文标签（与后端 ProjectAction 枚举一致）。 */
const OPERATION_ACTION_LABELS: Readonly<Record<string, string>> = {
  CREATE: '新建',
  EDIT: '编辑',
  DELETE: '删除',
  IMPORT_CREATE: '导入新增',
  IMPORT_OVERWRITE: '导入覆盖',
  IMPORT_SKIP: '导入跳过',
};

/** 操作记录变更字段中文标签（在项目资料标签上补充快照/审计字段）。 */
const OPERATION_FIELD_LABELS: Readonly<Record<string, string>> = {
  ...PROJECT_FIELD_LABELS,
  regionId: '地区 ID',
  progressId: '项目进度 ID',
  bizCategoryId: '业务分类 ID',
  progressSemantic: '金额语义',
  deletedAt: '删除时间',
};

/** 操作记录变更条目（单字段为单条；多字段编辑/导入/删除为字段映射逐条展开）。 */
interface OperationChangeRow {
  key: string;
  label: string;
  before: unknown;
  after: unknown;
}

/** 变更值展示：空值 —，数组按名称拼接（{id, name} 快照取 name），对象 JSON 序列化。 */
function formatOperationValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    return value.length === 0
      ? '—'
      : value.map((item) => (isRecord(item) ? String(item.name ?? JSON.stringify(item)) : String(item))).join('、');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 操作记录 before/after → 结构化变更行（单字段记录直接一条；字段映射按字段逐条）。 */
function buildOperationChanges(detail: RecordValue): OperationChangeRow[] {
  if (typeof detail.field === 'string' && detail.field) {
    return [{ key: detail.field, label: OPERATION_FIELD_LABELS[detail.field] ?? detail.field, before: detail.before, after: detail.after }];
  }
  const before = isRecord(detail.before) ? detail.before : {};
  const after = isRecord(detail.after) ? detail.after : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.map((key) => ({ key, label: OPERATION_FIELD_LABELS[key] ?? key, before: before[key], after: after[key] }));
}

/** 项目操作记录：列表 + 点行打开详情抽屉（中文标签、变更摘要结构化展示）。 */
function ProjectOperations() {
  const feedback = useFeedback();
  const [detailTarget, setDetailTarget] = useState<{ id: number; projectName: string | null } | null>(null);
  const [detail, setDetail] = useState<RecordValue | null>(null);
  useEffect(() => {
    if (!detailTarget) return;
    setDetail(null);
    void (async () => {
      try {
        setDetail(await http.get<RecordValue>(`/project-operations/${detailTarget.id}`, { service: 'fin', active: true }));
      } catch (error) {
        feedback.error(error, '操作记录详情加载失败');
      }
    })();
  }, [detailTarget, feedback]);
  return <>
    <DataTable title="项目操作记录" service="fin" endpoint="/project-operations" pageKey="fin-project-operations" columns={[{ key: 'projectName', title: '项目' }, { key: 'action', title: '操作' }, { key: 'operatorName', title: '操作者' }, { key: 'createdAt', title: '时间' }]} filterFields={[{ key: 'projectId', title: '项目', type: 'remote', remote: finProjectsSource }]} onRowClick={(row) => setDetailTarget({ id: Number(row.id), projectName: typeof row.projectName === 'string' ? row.projectName : null })} />
    <Drawer title="操作记录详情" open={detailTarget !== null} onClose={() => setDetailTarget(null)} width="min(92vw, 720px)">
      {detail ? <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Descriptions bordered column={1} size="small" items={[
          { key: 'project', label: '项目', children: detailTarget?.projectName ?? '—' },
          { key: 'action', label: '操作', children: OPERATION_ACTION_LABELS[String(detail.action ?? '')] ?? String(detail.action ?? '—') },
          { key: 'operatorName', label: '操作者', children: String(detail.operatorName ?? '—') },
          { key: 'createdAt', label: '时间', children: formatDisplayValue(detail.createdAt, 'createdAt') },
        ]} />
        <Table<OperationChangeRow> size="small" rowKey="key" pagination={false} dataSource={buildOperationChanges(detail)} locale={{ emptyText: '无变更明细' }} columns={[
          { key: 'label', title: '字段', dataIndex: 'label', width: 160 },
          { key: 'before', title: '变更前', render: (_, row) => <span style={{ whiteSpace: 'pre-wrap' }}>{formatOperationValue(row.before)}</span> },
          { key: 'after', title: '变更后', render: (_, row) => <span style={{ whiteSpace: 'pre-wrap' }}>{formatOperationValue(row.after)}</span> },
        ]} />
      </Space> : <Typography.Text>正在加载...</Typography.Text>}
    </Drawer>
  </>;
}

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
  const table = (title: string, kind: DetailKind, rows: DetailItem[]) => (
    <Card key={kind} size="small" title={title} extra={canMaintain ? <Button size="small" onClick={() => setEditing({ kind })}>新增</Button> : null}>
      <div className="wbme-desktop-table">
        <Table<DetailItem> size="small" rowKey="id" pagination={false} dataSource={rows} locale={{ emptyText: '暂无明细' }} columns={[{ key: 'amount', title: '金额', dataIndex: 'amount' }, { key: 'occurredDate', title: '日期', dataIndex: 'occurredDate' }, { key: 'remark', title: '备注', dataIndex: 'remark' }, ...(canMaintain ? [{ key: 'actions', title: '操作', render: (_: unknown, item: DetailItem) => <Space size="small"><Button size="small" onClick={() => setEditing({ kind, item })}>编辑</Button><Popconfirm title="确认删除这条金额明细？删除不可恢复。" onConfirm={() => void remove(kind, item)}><Button size="small" danger>删除</Button></Popconfirm></Space> }] : [])]} />
      </div>
      {/* 移动端：金额明细是只读键值（含编辑/删除操作），逐条成卡展示；触控目标由全局 44px 规则保证。 */}
      <div className="wbme-mobile-cards">
        {rows.length === 0 ? <Typography.Text type="secondary">暂无明细</Typography.Text> : (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {rows.map((item) => (
              <Card key={item.id} size="small">
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <Typography.Text type="secondary">金额</Typography.Text>
                    <span>{item.amount}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <Typography.Text type="secondary">日期</Typography.Text>
                    <span>{item.occurredDate ?? '—'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <Typography.Text type="secondary">备注</Typography.Text>
                    <span>{item.remark ?? '—'}</span>
                  </div>
                  {canMaintain ? (
                    <Space size="small">
                      <Button size="small" onClick={() => setEditing({ kind, item })}>编辑</Button>
                      <Popconfirm title="确认删除这条金额明细？删除不可恢复。" onConfirm={() => void remove(kind, item)}>
                        <Button size="small" danger>删除</Button>
                      </Popconfirm>
                    </Space>
                  ) : null}
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </div>
    </Card>
  );
  return <Drawer title="项目详情与金额明细" open onClose={onClose} width="min(92vw, 860px)">{detail ? <Space direction="vertical" size="large" style={{ width: '100%' }}><Card title="项目资料" size="small"><Descriptions bordered column={1} size="small" items={detailItems(isRecord(detail.project) ? detail.project : null, PROJECT_FIELD_LABELS, PROJECT_MONEY_KEYS)} /></Card><Card title="自动计算" size="small"><Descriptions bordered column={1} size="small" items={detailItems(isRecord(detail.auto) ? detail.auto : null, AUTO_FIELD_LABELS, PROJECT_MONEY_KEYS, new Set(['grossMargin']))} /></Card>{table('开票金额', 'invoice', detailRows('invoices'))}{table('已收回款', 'receipt', detailRows('receipts'))}{table('已付分包款', 'subcontract-payment', detailRows('subcontractPayments'))}</Space> : <Typography.Text>正在加载...</Typography.Text>}<ResourceFormModal title={editing?.item ? '编辑金额明细' : '新增金额明细'} open={editing !== null} onCancel={() => setEditing(null)} onSubmit={save} initialValues={editing?.item ?? {}} fields={[{ key: 'amount', label: '金额', type: 'number', required: true, width: 'narrow' }, { key: 'occurredDate', label: '日期', type: 'date' }, { key: 'remark', label: '备注', type: 'textarea', maxLength: 200 }]} /></Drawer>;
}

/** 利润分析（导出供组件测试；离开保护时序见 fin-profit-guard.spec，M22） */
export function ProfitAnalysis() {
  const feedback = useFeedback();
  const { can } = useSession();
  const { token } = theme.useToken();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<RecordValue[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [totals, setTotals] = useState<RecordValue | null>(null);
  const [loading, setLoading] = useState(true);
  // 单元格草稿（金额/文本统一；key = 行ID:字段），提交发生于失焦，避免每个字符都发起写请求
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 筛选：filters 为已应用条件（请求使用），filterDraft 为表单编辑中条件（应用前不触发请求）
  const [filters, setFilters] = useState<ProfitFilters>({});
  const [filterDraft, setFilterDraft] = useState<ProfitFilters>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // 撤销/重做栈（fin PRD §4：最多保留最近 50 次；新编辑提交后清空重做栈）
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);
  // 保存状态（fin PRD §4：保存中/已保存/保存失败）；有草稿或保存失败时离开需确认（M22）
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const dirtyRef = useRef(false);
  const canEdit = can('finance_maintain');
  // 导入入口收进页头操作区（批次清单口径：导入导出统一在页头）；弹层承载导入卡片
  const [importOpen, setImportOpen] = useState(false);

  // 站内跳转离开保护：存在未提交草稿或最近保存失败时确认（fin PRD §4「离开保护」）。
  // 项目为声明式 <BrowserRouter>，react-router 的 useBlocker 仅在数据路由下可用
  // （非数据路由调用必然抛错白屏，M22）；改用 location 变化检测 + 确认弹窗 + 回退。
  const location = useLocation();
  const navigate = useNavigate();
  const lastPathRef = useRef(`${location.pathname}${location.search}`);
  // 回退导航标记：弹窗选「留在本页」后 navigate 回退，避免该次导航再次触发确认（防重入）
  const restoreRef = useRef(false);
  // 用户确认「放弃」的时刻：放弃前发起的在途保存请求若随后失败，不再重新标记
  // dirtyRef（否则用户已离开本页，后续任意导航被无端二次拦截，M22 复核修复）
  const abandonedAtRef = useRef<number | null>(null);
  /** 放弃确认框：离开/翻页/应用筛选统一复用（确认 = 放弃未保存内容并继续动作）。 */
  const [discardPrompt, setDiscardPrompt] = useState<{ message: string; onConfirmed: () => void; onCancelled?: () => void } | null>(null);
  useEffect(() => {
    const current = `${location.pathname}${location.search}`;
    const previous = lastPathRef.current;
    lastPathRef.current = current;
    if (current === previous) return;
    if (restoreRef.current) {
      restoreRef.current = false;
      return;
    }
    // 未保存内容 = 草稿 / 保存失败标记 / 保存请求在途（M22 复核修复：在途保存
    // 期间导航离开，若保存随后失败用户无感知，PRD §4 要求「保存中」也在离开保护内）
    const hasUnsaved = Object.keys(drafts).length > 0 || dirtyRef.current || saveState === 'saving';
    if (!hasUnsaved) return;
    if (discardPrompt) return; // 确认框已打开时跳过（回退导航二次触发）
    setDiscardPrompt({
      message: '当前有未保存的编辑内容（草稿或保存失败），确定离开本页吗？',
      onConfirmed: () => {}, // 导航已发生，确认仅清空未保存内容（统一在 Modal onOk）
      onCancelled: () => {
        restoreRef.current = true;
        navigate(previous, { replace: true });
      },
    });
  }, [location, discardPrompt, drafts, saveState]);

  // 浏览器刷新/关闭离开保护（beforeunload 只能提示，无法阻止站内跳转）
  useEffect(() => {
    const hasDirty = () => Object.keys(drafts).length > 0 || dirtyRef.current || saveState === 'saving';
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hasDirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [drafts, saveState]);

  /** 是否还有未保存内容（草稿 / 保存失败标记 / 保存在途）。 */
  const hasUnsavedContent = () => Object.keys(drafts).length > 0 || dirtyRef.current || saveState === 'saving';
  /** 确认放弃未保存内容并继续（应用筛选/翻页共用；导航场景由 location effect 直接弹出）。 */
  const confirmDiscard = (message: string, onConfirmed: () => void) => {
    if (hasUnsavedContent()) {
      setDiscardPrompt({ message, onConfirmed });
      return;
    }
    onConfirmed();
  };

  /** 加载列表与总计（总计随筛选实时计算；fin PRD §4：总计不受当前页分页影响）。 */
  const load = async (nextPage: number, nextPageSize: number, nextFilters: ProfitFilters) => {
    setLoading(true);
    try {
      const [list, total] = await Promise.all([
        http.get<{ data: RecordValue[]; pagination?: { totalItems: number } }>(`/profit/projects${buildProfitQuery(nextFilters, nextPage, nextPageSize)}`, { service: 'fin', active: true }),
        http.get<RecordValue>(`/profit/totals${buildProfitQuery(nextFilters)}`, { service: 'fin', active: true }),
      ]);
      setRows(list.data);
      setTotalItems(list.pagination?.totalItems ?? list.data.length);
      setTotals(total);
    } catch (error) {
      feedback.error(error, '利润分析加载失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(1, 20, {}); }, []); // 首次加载；保存后在本地精确回填。

  // 相同单元格（项目+字段）的连续保存串行处理（fin PRD §4：同单元格按发起顺序，
  // 不同单元格可并行）——串行链按 key 隔离，互不阻塞。
  const cellChains = useRef(new Map<string, Promise<boolean>>());
  const saveCell = async (row: RecordValue, field: string, value: string, fromUndo = false): Promise<boolean> => {
    const projectId = Number(row.id);
    if (!Number.isInteger(projectId)) return false;
    const chainKey = `${projectId}:${field}`;
    const previous = cellChains.current.get(chainKey) ?? Promise.resolve(true);
    const next = previous.then(() => saveCellInner(row, field, value, fromUndo)).finally(() => {
      if (cellChains.current.get(chainKey) === next) {
        cellChains.current.delete(chainKey);
      }
    });
    cellChains.current.set(chainKey, next);
    return next;
  };

  /** 单元格即时保存（单字段 + 幂等键；dataRevision 响应排序保护；成功后入撤销栈）。 */
  const saveCellInner = async (row: RecordValue, field: string, value: string, fromUndo: boolean): Promise<boolean> => {
    const projectId = Number(row.id);
    const original = row[field] === null || row[field] === undefined ? '' : String(row[field]);
    if (value === original) {
      setSaveState('saved');
      return true;
    }
    const startedAt = Date.now();
    setSaveState('saving');
    try {
      const result = await http.put<{ value: unknown; auto: RecordValue; dataRevision: number }>('/profit/cells', { projectId, field, value }, { service: 'fin' });
      // 响应排序保护：只应用不低于当前行修订号的响应，避免并行请求乱序时旧汇总覆盖新汇总
      setRows((current) => current.map((item) => {
        if (Number(item.id) !== projectId) return item;
        if (Number(result.dataRevision ?? 0) < Number(item.dataRevision ?? 0)) return item;
        return { ...item, [field]: result.value, ...result.auto, dataRevision: result.dataRevision };
      }));
      if (!fromUndo) {
        // 撤销栈保存每次成功编辑的字段、编辑前值与编辑后值（最多 50 次）；新编辑清空重做栈
        setUndoStack((stack) => {
          const next = [...stack, { projectId, rowName: String(row.name ?? `#${projectId}`), field, before: original, after: value }];
          return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next;
        });
        setRedoStack([]);
      }
      setSaveState('saved');
      dirtyRef.current = false;
      feedback.success('已保存');
      return true;
    } catch (error) {
      setSaveState('error');
      // 请求发起于用户「放弃」之前 → 该失败属于已确认放弃的内容，不再置
      // dirtyRef（否则离开后再次导航会被无端拦截；放弃后的新编辑失败仍正常标记）
      if (abandonedAtRef.current === null || startedAt >= abandonedAtRef.current) {
        dirtyRef.current = true;
      }
      feedback.error(error, '单元格保存失败');
      return false;
    }
  };

  /** 提交单元格草稿（失焦时；无差异直接清除草稿不发起请求）。 */
  const commitCell = async (row: RecordValue, field: string, original: string, draftKey: string) => {
    const value = drafts[draftKey] ?? original;
    if (value === original) {
      clearDraft(draftKey);
      return;
    }
    if (await saveCell(row, field, value)) {
      clearDraft(draftKey);
    }
  };

  const clearDraft = (draftKey: string) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
  };

  /** 撤销/重做：重新提交编辑前值/编辑后值（新幂等键，视为新编辑；成功后转入另一栈）。 */
  const applyUndoEntry = async (entry: UndoEntry, undo: boolean) => {
    const target = undo ? entry.before : entry.after;
    // 目标行不在当前页时按最小行提交（撤销只覆盖数据库值，列表无需回填）
    const row = rows.find((item) => Number(item.id) === entry.projectId) ?? { id: entry.projectId, name: entry.rowName };
    if (await saveCell(row as RecordValue, entry.field, target, true)) {
      if (undo) setRedoStack((stack) => [...stack, entry]);
      else setUndoStack((stack) => [...stack, entry]);
    }
  };
  const doUndo = async () => {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    setUndoStack((stack) => stack.slice(0, -1));
    await applyUndoEntry(entry, true);
  };
  const doRedo = async () => {
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return;
    setRedoStack((stack) => stack.slice(0, -1));
    await applyUndoEntry(entry, false);
  };

  // 全局撤销/重做快捷键：⌘Z / Ctrl+Z（撤销）、⌘⇧Z / Ctrl+Y（重做），并提供工具栏按钮
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        void doUndo();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        void doRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  /** 应用筛选（有未保存内容时先确认放弃；重置回第 1 页）。 */
  const applyFilters = () => {
    const next = filterDraft;
    const run = () => {
      setFilters(next);
      setPage(1);
      void load(1, pageSize, next);
    };
    confirmDiscard('当前有未保存的编辑内容（草稿或保存失败），应用筛选将放弃这些内容，确定继续吗？', run);
  };
  const resetFilters = () => {
    setFilterDraft({});
    const run = () => {
      setFilters({});
      setPage(1);
      void load(1, pageSize, {});
    };
    confirmDiscard('当前有未保存的编辑内容（草稿或保存失败），重置筛选将放弃这些内容，确定继续吗？', run);
  };
  /** 翻页/改页大小（有未保存内容时先确认放弃；fin PRD §4：翻页不得无提示离开）。 */
  const changePage = (nextPage: number, nextPageSize: number) => {
    const run = () => {
      setPage(nextPage);
      setPageSize(nextPageSize);
      void load(nextPage, nextPageSize, filters);
    };
    confirmDiscard('当前有未保存的编辑内容（草稿或保存失败），翻页将放弃这些内容，确定继续吗？', run);
  };

  /** 利润分析导出（页头操作区）；「导出已筛选」携带当前筛选条件（批次 6-5）。 */
  const exportFile = async (scope: 'all' | 'filtered') => {
    try {
      const query = scope === 'filtered' ? buildProfitQuery(filters) : '';
      const blob = await download(`/profit/excel/export/${scope}${query}`, { service: 'fin', active: true });
      triggerDownload(blob, `profit-${scope}.xlsx`);
    } catch (error) {
      feedback.error(error, 'Excel 导出失败');
    }
  };

  /** 保存状态标签（fin PRD §4：保存中/已保存/保存失败） */
  const saveStatusTag = () => {
    if (saveState === 'saving') {
      return <Typography.Text type="warning">保存中...</Typography.Text>;
    }
    if (saveState === 'error') {
      return <Typography.Text type="danger">保存失败，请重试或检查网络</Typography.Text>;
    }
    if (saveState === 'saved') {
      return <Typography.Text type="success">已保存</Typography.Text>;
    }
    return null;
  };

  /** 编辑态键盘导航（fin PRD §4）：方向键移动焦点、Enter 确认并下移、Tab 横向移动、Esc 取消恢复原值。 */
  const handleCellKeyDown = (row: RecordValue, field: string) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    const rowIndex = rows.findIndex((item) => Number(item.id) === Number(row.id));
    if (event.key === 'Escape') {
      // Esc：取消本次编辑并恢复原值（清除草稿后失焦，失焦因无差异不触发保存）
      event.preventDefault();
      clearDraft(`${String(row.id)}:${field}`);
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // 方向键：失焦（确认并保存当前编辑）后焦点移到相邻行同列单元格
      event.preventDefault();
      event.currentTarget.blur();
      moveCellFocus(rowIndex, field, event.key === 'ArrowDown' ? 1 : -1, 0);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      // 左右方向键：横向移动到相邻可编辑单元格（与 Tab/Shift+Tab 同路径）
      event.preventDefault();
      event.currentTarget.blur();
      moveCellFocus(rowIndex, field, 0, event.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (event.key === 'Tab') {
      // Tab：横向移动到相邻可编辑单元格（Shift+Tab 反向）
      event.preventDefault();
      event.currentTarget.blur();
      moveCellFocus(rowIndex, field, 0, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Enter') {
      // Enter：确认本次编辑并移动到下方单元格（失焦触发保存）
      event.preventDefault();
      event.currentTarget.blur();
      moveCellFocus(rowIndex, field, 1, 0);
    }
  };

  /** 按行列偏移移动编辑焦点（横向只在可编辑列之间移动）。 */
  const moveCellFocus = (fromRow: number, fromField: string, dRow: number, dCol: number) => {
    const fromCol = PROFIT_COLUMNS.findIndex((column) => column.key === fromField);
    const fromEditIndex = EDITABLE_COL_INDEXES.indexOf(fromCol);
    if (fromEditIndex < 0) return;
    const targetEditIndex = Math.min(Math.max(fromEditIndex + dCol, 0), EDITABLE_COL_INDEXES.length - 1);
    const targetCol = EDITABLE_COL_INDEXES[targetEditIndex];
    const targetRow = Math.min(Math.max(fromRow + dRow, 0), rows.length - 1);
    if (targetCol === undefined) return;
    const targetField = PROFIT_COLUMNS[targetCol]?.key;
    if (targetField === undefined) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-profit-cell="${targetRow}:${targetField}"]`)?.focus();
  };

  const renderCell = (field: string) => (value: unknown, row: RecordValue) => {
    const text = value === null || value === undefined ? '' : String(value);
    const column = PROFIT_COLUMNS.find((item) => item.key === field);
    // 只读/自动列：金额千分位、比率百分比、负数红色（主 PRD §9.11 仅展示层格式化）
    if (!canEdit || !EDITABLE_FIELDS.has(field)) {
      if (column?.ratio) return formatPercentage(value);
      if (column?.money) {
        const formatted = formatMoney(value);
        return column?.negative && text.startsWith('-') ? <span style={{ color: token.colorError }}>{formatted}</span> : formatted;
      }
      if (column?.negative && text.startsWith('-')) return <span style={{ color: token.colorError }}>{text}</span>;
      return text || '—';
    }
    const draftKey = `${String(row.id)}:${field}`;
    const draft = drafts[draftKey] ?? text;
    const rowIndex = rows.findIndex((item) => Number(item.id) === Number(row.id));
    const cellId = `${rowIndex}:${field}`;
    const keyDown = handleCellKeyDown(row, field);
    if (MONEY_FIELDS.has(field)) {
      return <InputNumber<string> stringMode value={draft} aria-label={`${String(row.name ?? '项目')} ${field}`} data-profit-cell={cellId} style={{ width: '100%' }} onChange={(nextValue) => setDrafts((current) => ({ ...current, [draftKey]: nextValue ?? '' }))} onKeyDown={keyDown} onPressEnter={(event) => event.currentTarget.blur()} onBlur={() => void commitCell(row, field, text, draftKey)} />;
    }
    return <Input value={draft} aria-label={`${String(row.name ?? '项目')} ${field}`} data-profit-cell={cellId} onChange={(event) => setDrafts((current) => ({ ...current, [draftKey]: event.target.value }))} onKeyDown={keyDown} onPressEnter={(event) => event.currentTarget.blur()} onBlur={() => void commitCell(row, field, text, draftKey)} />;
  };
  /** 总计统计行（当前筛选结果汇总，随筛选实时计算；指标自带中文标签与统一格式化）。 */
  const summaryRow = totals ? (
    <Table.Summary.Row>
      <Table.Summary.Cell index={0} colSpan={7}><Typography.Text strong>总计</Typography.Text></Table.Summary.Cell>
      <Table.Summary.Cell index={7}><Typography.Text strong>累计收款<br />{formatMoney(totals.totalReceived)}</Typography.Text></Table.Summary.Cell>
      <Table.Summary.Cell index={8} colSpan={2}><Typography.Text strong>累计分包付款<br />{formatMoney(totals.totalSubcontractPaid)}</Typography.Text></Table.Summary.Cell>
      <Table.Summary.Cell index={10} colSpan={2}><Typography.Text strong>暂定保通权益<br />{formatMoney(totals.equity)}</Typography.Text></Table.Summary.Cell>
      <Table.Summary.Cell index={12} colSpan={2}><Typography.Text strong>毛利率<br />{formatPercentage(totals.grossMargin)}</Typography.Text></Table.Summary.Cell>
    </Table.Summary.Row>
  ) : null;

  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>利润分析</Typography.Title>
        <Space>{saveStatusTag()}{Object.keys(drafts).length > 0 ? <Typography.Text type="warning">有 {Object.keys(drafts).length} 个未提交草稿</Typography.Text> : null}</Space>
      </div>
      {/* 页头操作区：撤销/重做（⌘Z / ⌘⇧Z）+ 导入 + 导出（导出已筛选携带当前筛选条件） */}
      <Space wrap>
        <Button icon={<UndoOutlined />} disabled={undoStack.length === 0} onClick={() => void doUndo()}>撤销</Button>
        <Button icon={<RedoOutlined />} disabled={redoStack.length === 0} onClick={() => void doRedo()}>重做</Button>
        {canEdit ? <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>导入</Button> : null}
        <Button icon={<DownloadOutlined />} onClick={() => void exportFile('all')}>导出全部</Button>
        <Button icon={<ExportOutlined />} onClick={() => void exportFile('filtered')}>导出已筛选</Button>
      </Space>
    </div>
    {/* 筛选条：按项目名称/年度/地区/业务分类/项目进度筛选（fin PRD §4）；应用/重置在有未保存内容时先确认 */}
    <Card size="small">
      <Space wrap>
        <Input allowClear placeholder="项目名称" value={filterDraft.name ?? ''} onChange={(event) => setFilterDraft((current) => ({ ...current, name: event.target.value || undefined }))} style={{ width: 180 }} />
        <InputNumber placeholder="年度" min={1000} max={9999} value={filterDraft.year} onChange={(value) => setFilterDraft((current) => ({ ...current, year: typeof value === 'number' ? value : undefined }))} style={{ width: 120 }} />
        <RemoteSelect source={PROFIT_REGION_SOURCE} placeholder="地区" value={filterDraft.regionId} onChange={(value) => setFilterDraft((current) => ({ ...current, regionId: typeof value === 'number' ? value : undefined }))} style={{ width: 160 }} />
        <RemoteSelect source={PROFIT_CATEGORY_SOURCE} placeholder="业务分类" value={filterDraft.bizCategoryId} onChange={(value) => setFilterDraft((current) => ({ ...current, bizCategoryId: typeof value === 'number' ? value : undefined }))} style={{ width: 160 }} />
        <RemoteSelect source={PROFIT_PROGRESS_SOURCE} placeholder="项目进度" value={filterDraft.progressId} onChange={(value) => setFilterDraft((current) => ({ ...current, progressId: typeof value === 'number' ? value : undefined }))} style={{ width: 160 }} />
        <Button type="primary" onClick={applyFilters}>应用筛选</Button>
        <Button onClick={resetFilters}>重置</Button>
      </Space>
    </Card>
    {canEdit && importOpen ? (
      <Modal title="导入" open footer={null} width="min(92vw, 720px)" onCancel={() => setImportOpen(false)} destroyOnHidden>
        <ImportCard />
      </Modal>
    ) : null}
    <Card loading={loading} styles={{ body: { padding: 0 } }}>
      <div className="wbme-desktop-table" ref={gridRef}>
        <Table<RecordValue> rowKey={(row) => String(row.id)} dataSource={rows} pagination={false} scroll={{ x: 'max-content' }} summary={summaryRow ? () => summaryRow : undefined} columns={PROFIT_COLUMNS.map((column) => ({ key: column.key, dataIndex: column.key, title: column.title, fixed: column.key === 'name' ? 'left' as const : undefined, width: column.width, render: renderCell(column.key) }))} />
      </div>
      {/* L30：移动端卡片化（编辑态卡片复用 renderCell 控件与同一保存接口；字段集与桌面一致） */}
      <div className="wbme-mobile-cards" style={{ padding: 16 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {rows.map((row) => (
            <Card key={String(row.id)} size="small">
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <Typography.Text strong>{String(row.name ?? '—')}</Typography.Text>
                  <Typography.Text type="secondary">{row.year === null || row.year === undefined ? '' : `${String(row.year)} 年`}</Typography.Text>
                </div>
                {[
                  { key: 'partyA', label: '甲方' },
                  { key: 'generalContractor', label: '总包方' },
                  { key: 'managementFee', label: '管理费' },
                  { key: 'contractAmount', label: '合同金额' },
                  { key: 'paymentNode', label: '主合同付款节点' },
                  { key: 'tentativeAuditedAmount', label: '暂定/审定金额' },
                  { key: 'totalInvoiced', label: '累计开票' },
                  { key: 'totalReceived', label: '累计收款' },
                  { key: 'remainingUninvoiced', label: '剩余未开票' },
                  { key: 'remainingUnreceived', label: '剩余未收款' },
                  { key: 'settlement', label: '分包结算' },
                  { key: 'miscExpense', label: '零星费用' },
                  { key: 'remark', label: '备注' },
                ].map(({ key, label }) => (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
                    <Typography.Text type="secondary">{label}</Typography.Text>
                    <span>{renderCell(key)(row[key], row)}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <Typography.Text type="secondary">毛利率</Typography.Text>
                  <span>{renderCell('grossMargin')(row.grossMargin, row)}</span>
                </div>
              </Space>
            </Card>
          ))}
        </Space>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 16 }}>
        <Pagination current={page} pageSize={pageSize} total={totalItems} showSizeChanger onChange={changePage} showTotal={(total) => `共 ${total} 条`} />
      </div>
    </Card>
    <Modal
      open={discardPrompt !== null}
      title="未保存的编辑内容"
      okText="放弃并离开"
      cancelText="留在本页"
      onOk={() => {
        // 确认放弃：清空草稿与保存失败标记，保护基于「是否存在新编辑内容」重新生效；
        // 记录放弃时刻，放弃前发起的在途保存请求随后失败不再重新标记（M22 复核修复）。
        abandonedAtRef.current = Date.now();
        setDrafts({});
        dirtyRef.current = false;
        setSaveState('idle');
        const action = discardPrompt?.onConfirmed;
        setDiscardPrompt(null);
        action?.();
      }}
      onCancel={() => {
        const action = discardPrompt?.onCancelled;
        setDiscardPrompt(null);
        action?.();
      }}
    >
      <p>{discardPrompt?.message ?? '当前有未保存的编辑内容（草稿或保存失败），确定离开本页吗？'}</p>
    </Modal>
  </Space>;
}

/** 利润分析导入（数据维护能力，仅 maintain 可见）；预览与确认均限时处理，不留存原文件。 */
function ImportCard() {
  const feedback = useFeedback();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, 'OVERWRITE' | 'SKIP'>>({});
  // L26：覆盖数据丢失警告确认（行号 → 是否勾选确认）
  const [confirmWarnings, setConfirmWarnings] = useState<Record<number, boolean>>({});
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
    setConfirmWarnings({});
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
      setConfirmWarnings({});
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
      form.append('choices', JSON.stringify(importChoices(preview, choices, confirmWarnings)));
      await upload('/profit/excel/import/confirm', form, { service: 'fin', idempotencyKey: crypto.randomUUID() });
      feedback.success('Excel 导入已完成');
      setPreview(null);
      setFile(null);
      setChoices({});
      setConfirmWarnings({});
    } catch (error) {
      feedback.error(error, 'Excel 导入确认失败');
    } finally {
      setLoading(false);
    }
  };
  return <Card title="导入">
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Upload accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" maxCount={1} beforeUpload={selectFile} onRemove={() => { setFile(null); setPreview(null); setChoices({}); setConfirmWarnings({}); }}>
        <Button icon={<ImportOutlined />}>选择 Excel 文件</Button>
      </Upload>
      <Space wrap><Button type="primary" disabled={!file} loading={loading} onClick={() => void previewFile()}>生成预览</Button><Button disabled={!preview || loading || hasUnconfirmedWarning(preview, choices, confirmWarnings)} onClick={() => void confirmFile()}>确认导入</Button></Space>
      {preview ? <><Space wrap>
        {/* fin PRD §4：预览提供「全部覆盖/全部跳过」快捷操作（数据丢失警告的确认勾选仍须逐行阅读后勾选，不可快捷跳过） */}
        <Button disabled={loading} onClick={() => setChoices(Object.fromEntries((preview.pendingChoice ?? []).map((item) => [item.rowNumber, 'OVERWRITE'])))}>全部覆盖</Button>
        <Button disabled={loading} onClick={() => setChoices(Object.fromEntries((preview.pendingChoice ?? []).map((item) => [item.rowNumber, 'SKIP'])))}>全部跳过</Button>
      </Space><ImportPreviewCard preview={preview} choices={choices} confirmations={confirmWarnings} onChoiceChange={(rowNumber, decision) => setChoices((current) => ({ ...current, [rowNumber]: decision }))} onConfirmChange={(rowNumber, confirmed) => setConfirmWarnings((current) => ({ ...current, [rowNumber]: confirmed }))} /></> : null}
    </Space>
  </Card>;
}

/** 财务字典类型中文标签（删除预览引用明细展示）。 */
const FIN_DICT_TYPE_LABELS: Readonly<Record<string, string>> = {
  PROGRESS: '项目进度',
  COMPLETENESS: '资料齐全度',
  BIZ_CATEGORY: '业务分类',
  REGION: '地区',
};

/** 财务运行参数字段中文标签（JsonDetails labelMap；通用字段走共享映射）。 */
const FIN_SETTINGS_LABELS: Readonly<Record<string, string>> = {
  items: '运行参数',
  key: '参数键',
  value: '参数值',
  valueType: '值类型',
  label: '显示名称',
  updatedBy: '更新人 ID',
};

function FinanceConfig() {
  return <Card>
    <Tabs items={[
      { key: 'params', label: '运行参数', children: <JsonDetails title="财务运行参数" service="fin" endpoint="/finance-settings" labelMap={FIN_SETTINGS_LABELS} /> },
      { key: 'dicts', label: '财务字典', children: <ResourcePage title="财务字典" service="fin" endpoint="/finance-dict-items" pageKey="fin-dicts" columns={[{ key: 'dictType', title: '类型' }, { key: 'name', title: '名称' }, { key: 'semantic', title: '金额语义' }, { key: 'status', title: '状态' }]} filterFields={[{ key: 'dictType', title: '类型', type: 'enum', options: [{ label: '项目进度', value: 'PROGRESS' }, { label: '资料齐全度', value: 'COMPLETENESS' }, { label: '业务分类', value: 'BIZ_CATEGORY' }, { label: '地区', value: 'REGION' }] }]} create={{ title: '新建财务字典项', endpoint: '/finance-dict-items', fields: [{ key: 'dictType', label: '字典类型', type: 'select', required: true, options: [{ label: '项目进度', value: 'PROGRESS' }, { label: '资料齐全度', value: 'COMPLETENESS' }, { label: '业务分类', value: 'BIZ_CATEGORY' }, { label: '地区', value: 'REGION' }] }, { key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'semantic', label: '金额语义', type: 'select', options: [{ label: '暂定', value: 'TENTATIVE' }, { label: '审定', value: 'AUDITED' }], width: 'narrow' }, { key: 'sort', label: '排序', type: 'number', width: 'narrow' }] }} edit={{ title: '编辑财务字典项', endpoint: (id) => `/finance-dict-items/${id}`, fields: [{ key: 'name', label: '名称', maxLength: 100 }, { key: 'semantic', label: '金额语义', type: 'select', options: [{ label: '暂定', value: 'TENTATIVE' }, { label: '审定', value: 'AUDITED' }], width: 'narrow' }, { key: 'sort', label: '排序', type: 'number', width: 'narrow' }, { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }], width: 'narrow' }] }} batchDelete={{ endpoint: '/finance-dict-items/batch', bodyKey: 'ids', previewEndpoint: '/finance-dict-items/delete-preview', previewItem: (item) => ({ name: String(item.name ?? '—'), refs: `被工程合同引用 ${String(item.referencedCount ?? 0)} 处（${FIN_DICT_TYPE_LABELS[String(item.dictType ?? '')] ?? String(item.dictType ?? '未知类型')}）` }) }} /> },
    ]} />
  </Card>;
}

/** 导入预览分页大小：桌面表格与移动端卡片共用（批次 7：两形态共享同一分页状态）。 */
const PREVIEW_PAGE_SIZE = 20;

function ImportPreviewCard({ preview, choices, confirmations, onChoiceChange, onConfirmChange }: {
  preview: ImportPreview;
  choices: Record<number, 'OVERWRITE' | 'SKIP'>;
  confirmations: Record<number, boolean>;
  onChoiceChange: (rowNumber: number, decision: 'OVERWRITE' | 'SKIP') => void;
  onConfirmChange: (rowNumber: number, confirmed: boolean) => void;
}) {
  const pending = preview.pendingChoice ?? [];
  // 移动端逐行卡片与桌面表格共享分页状态；重新生成预览时回到第一页。
  const [previewPage, setPreviewPage] = useState(1);
  useEffect(() => setPreviewPage(1), [preview]);
  const pagedPending = pending.slice((previewPage - 1) * PREVIEW_PAGE_SIZE, previewPage * PREVIEW_PAGE_SIZE);
  return <Card size="small" title="导入预览">
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {preview.summary ? <Typography.Text>汇总：{Object.entries(preview.summary).map(([key, value]) => `${key} ${String(value)}`).join('，')}</Typography.Text> : null}
      {pending.length > 0 ? <>
        <div className="wbme-desktop-table">
          <Table<PreviewChoice> size="small" rowKey="rowNumber" dataSource={pending} pagination={{ current: previewPage, pageSize: PREVIEW_PAGE_SIZE, showSizeChanger: false, showTotal: (total) => `共 ${total} 条待选择记录`, onChange: setPreviewPage }} columns={[
            { key: 'rowNumber', title: '行', dataIndex: 'rowNumber', width: 70 },
            { key: 'name', title: '项目', dataIndex: 'name' },
            { key: 'year', title: '年度', dataIndex: 'year', width: 100 },
            { key: 'warning', title: '提示', render: (_, row) => row.dataLossWarning ? '覆盖会清空原明细的日期/备注' : '—' },
            { key: 'decision', title: '处理', render: (_, row) => <Select value={choices[row.rowNumber] ?? 'SKIP'} style={{ minWidth: 120 }} options={[{ label: '跳过', value: 'SKIP' }, { label: '覆盖', value: 'OVERWRITE' }]} onChange={(value: 'OVERWRITE' | 'SKIP') => onChoiceChange(row.rowNumber, value)} /> },
            // L26：覆盖数据丢失警告须显式勾选确认（未确认时确认导入按钮禁用）
            { key: 'confirm', title: '警告确认', render: (_, row) => row.dataLossWarning
              ? <Checkbox checked={confirmations[row.rowNumber] ?? false} disabled={(choices[row.rowNumber] ?? 'SKIP') !== 'OVERWRITE'} onChange={(event) => onConfirmChange(row.rowNumber, event.target.checked)}>已阅读并确认</Checkbox>
              : null },
          ]} />
        </div>
        {/* 移动端：逐行决策与警告确认（L26）须同屏可达，改卡片纵排，避免横向滚动找勾选。 */}
        <div className="wbme-mobile-cards">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {pagedPending.map((row) => (
              <Card key={row.rowNumber} size="small">
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <Typography.Text type="secondary">行</Typography.Text>
                    <span>{row.rowNumber}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <Typography.Text type="secondary">项目</Typography.Text>
                    <span>{row.name}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <Typography.Text type="secondary">年度</Typography.Text>
                    <span>{row.year ?? '—'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <Typography.Text type="secondary">提示</Typography.Text>
                    <span>{row.dataLossWarning ? '覆盖会清空原明细的日期/备注' : '—'}</span>
                  </div>
                  <div>
                    <Typography.Text type="secondary">处理</Typography.Text>
                    <Select value={choices[row.rowNumber] ?? 'SKIP'} style={{ width: '100%', marginTop: 4 }} options={[{ label: '跳过', value: 'SKIP' }, { label: '覆盖', value: 'OVERWRITE' }]} onChange={(value: 'OVERWRITE' | 'SKIP') => onChoiceChange(row.rowNumber, value)} />
                  </div>
                  {row.dataLossWarning ? (
                    <Checkbox checked={confirmations[row.rowNumber] ?? false} disabled={(choices[row.rowNumber] ?? 'SKIP') !== 'OVERWRITE'} onChange={(event) => onConfirmChange(row.rowNumber, event.target.checked)}>已阅读并确认</Checkbox>
                  ) : null}
                </Space>
              </Card>
            ))}
          </Space>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <Pagination current={previewPage} pageSize={PREVIEW_PAGE_SIZE} total={pending.length} showSizeChanger={false} onChange={setPreviewPage} />
          </div>
        </div>
      </> : null}
      {(preview.created?.length ?? 0) > 0 ? <Typography.Text type="success">将新增 {preview.created?.length} 行。</Typography.Text> : null}
      {(preview.conflicts?.length ?? 0) > 0 ? <Typography.Text type="warning">存在 {preview.conflicts?.length} 行冲突，不能导入。</Typography.Text> : null}
      {(preview.errors?.length ?? 0) > 0 ? <Typography.Text type="danger">存在 {preview.errors?.length} 行校验错误，不能导入。</Typography.Text> : null}
    </Space>
  </Card>;
}

/** 是否存在"覆盖 + 有数据丢失警告 + 未勾选确认"的待导入行（L26：有则禁用确认按钮） */
function hasUnconfirmedWarning(preview: ImportPreview | null, choices: Record<number, 'OVERWRITE' | 'SKIP'>, confirmations: Record<number, boolean>): boolean {
  return (preview?.pendingChoice ?? []).some(
    (item) => item.dataLossWarning && (choices[item.rowNumber] ?? 'SKIP') === 'OVERWRITE' && confirmations[item.rowNumber] !== true,
  );
}

function importChoices(preview: ImportPreview | null, choices: Record<number, 'OVERWRITE' | 'SKIP'>, confirmations: Record<number, boolean>): Array<{ rowNumber: number; decision: 'OVERWRITE' | 'SKIP'; projectId: number; dataRevision: number; confirmDataLossWarning?: boolean }> {
  return (preview?.pendingChoice ?? []).map((item) => ({
    rowNumber: item.rowNumber,
    decision: choices[item.rowNumber] ?? 'SKIP',
    projectId: item.projectId,
    dataRevision: item.dataRevision,
    // L26：仅对有警告的覆盖行提交确认标记
    confirmDataLossWarning: item.dataLossWarning ? confirmations[item.rowNumber] ?? false : undefined,
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
