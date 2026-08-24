import { Button, Card, Descriptions, Drawer, Form, Input, Popconfirm, Space, Spin, Table, Timeline, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { DataTable, StatusTag } from './DataTable';
import { ConfirmAction } from './ConfirmAction';
import { formatBeijingDateTime } from './display-format';
import { useFeedback } from '../request/feedback';
import { http, type ApiService } from '../request/http';
import { useSession } from '../request/session';

type RecordValue = Record<string, unknown>;

/** 处理动作中文（主 PRD §3.2 处理记录时间线）。 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  SUBMIT: '提交',
  APPROVE: '批准',
  REJECT: '驳回',
  CANCEL: '取消',
  AUTO_CANCEL: '超时自动取消',
};

/** 取消来源中文（主 PRD §3.2：人工取消 / 账号注销 / 超时自动取消）。 */
const CANCEL_SOURCE_LABELS: Readonly<Record<string, string>> = {
  USER: '申请人/代交人取消',
  ACCOUNT_DEACTIVATED: '账号注销自动取消',
  OVERDUE: '超时自动取消',
};

/** 处理动作时间线颜色（终态动作区分语义）。 */
const ACTION_COLORS: Readonly<Record<string, string>> = {
  SUBMIT: 'blue',
  APPROVE: 'green',
  REJECT: 'red',
  CANCEL: 'gray',
  AUTO_CANCEL: 'gray',
};

/** 分钟数转 HH:mm（加班明细展示；非法值显示占位）。 */
function minuteToTime(value: unknown): string {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) return '—';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** 已等待时长（天/小时/分钟；主 PRD §3.2 页面展示）。 */
function formatWaitDuration(submittedAt: unknown, now: Date): string {
  const start = new Date(String(submittedAt)).getTime();
  if (Number.isNaN(start)) return '';
  const diff = Math.max(0, now.getTime() - start);
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

interface ApprovalCenterProps {
  title: string;
  service: ApiService;
  pageKey: string;
}

/**
 * 统一审批中心：在当前页面抽屉展示申请信息、申请对象列表、处理记录时间线与当前状态，
 * 支持「上一条 / 下一条」切换待办（主 PRD §3.2）。
 * 处理请求只提交服务端允许的 action/opinion，状态机、范围与并发由后端最终校验。
 */
export function ApprovalCenter({ title, service, pageKey }: ApprovalCenterProps) {
  const feedback = useFeedback();
  const { user } = useSession();
  const [rows, setRows] = useState<RecordValue[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [detail, setDetail] = useState<RecordValue | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [form] = Form.useForm<{ opinion?: string }>();
  const current = currentIndex === null ? null : rows[currentIndex] ?? null;
  const requestTypeOptions = service === 'asset'
    ? [
        { label: '入库申请', value: 'STOCK_IN' },
        { label: '库存变更', value: 'STOCK_CHANGE' },
        { label: '消耗品申领', value: 'CONSUMABLE_REQUEST' },
        { label: '代领申请', value: 'AGENT_REQUEST' },
        { label: '归还申请', value: 'RETURN' },
        { label: '核销申请', value: 'WRITE_OFF' },
        { label: '代领结清', value: 'AGENT_SETTLEMENT' },
      ]
    : service === 'hr'
      ? [{ label: '加班申请', value: 'OVERTIME' }, { label: '岗位变更', value: 'POSITION_CHANGE' }]
      : [];

  // 已等待时长实时刷新（每分钟；主 PRD §3.2 页面展示提交时间与已等待时长）
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!current?.id) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    // 切换时清空旧详情并进入加载态，避免瞬间展示上一条内容（批次 6-8）
    setDetail(null);
    setDetailLoading(true);
    let cancelled = false;
    void http.get<RecordValue>(`/approval-requests/${String(current.id)}`, { service, active: true })
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error) => {
        if (!cancelled) feedback.error(error, '审批详情加载失败');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [current?.id, feedback, service]);

  const process = async (action: 'APPROVE' | 'REJECT') => {
    if (!current?.id) return;
    try {
      const opinion = form.getFieldValue('opinion');
      if (action === 'REJECT' && !opinion?.trim()) {
        feedback.error(new Error('请填写驳回原因'), '请填写驳回原因');
        return;
      }
      await http.post(`/approval-requests/${String(current.id)}/process`, { action, opinion }, { service });
      feedback.success(action === 'APPROVE' ? '审批已批准' : '审批已驳回');
      setCurrentIndex(null);
      form.resetFields();
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '处理审批失败');
    }
  };
  const cancel = async () => {
    if (!current?.id) return;
    try {
      await http.post(`/approval-requests/${String(current.id)}/cancel`, {}, { service });
      feedback.success('申请已取消');
      setCurrentIndex(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '取消申请失败');
    }
  };
  const canCancel = detail?.applicantId === user?.id || detail?.proxyId === user?.id || current?.applicantId === user?.id;

  const request = isRecord(detail?.request) ? detail.request : null;
  const actions = Array.isArray(detail?.actions) ? detail.actions as RecordValue[] : [];
  const requestTypeLabel = (value: unknown) => requestTypeOptions.find((option) => option.value === value)?.label ?? String(value ?? '—');

  /** 申请信息（中文标签 + 关联名称；待审批附已等待时长与超时自动取消规则提示）。 */
  const infoItems = (() => {
    if (!request) return [];
    const items: Array<{ label: string; children: React.ReactNode }> = [
      { label: '申请单号', children: String(request.applicationNo ?? '—') },
      { label: '申请类型', children: requestTypeLabel(request.requestType) },
      { label: '申请人', children: String(request.applicantName ?? request.applicantId ?? '—') },
    ];
    if (request.proxyName !== null && request.proxyName !== undefined) {
      items.push({ label: '代交人', children: String(request.proxyName) });
    }
    items.push({ label: '状态', children: <StatusTag value={request.status} /> });
    if (request.submittedAt) {
      items.push({ label: '提交时间', children: formatBeijingDateTime(String(request.submittedAt)) });
    }
    if (request.status === 'PENDING') {
      items.push({ label: '已等待', children: formatWaitDuration(request.submittedAt, now) });
      items.push({ label: '超时规则', children: '待审批超过系统设置「审批超时自动取消天数」（默认 30 天）后自动取消' });
    }
    if (request.processorName !== null && request.processorName !== undefined) {
      items.push({ label: '处理人', children: String(request.processorName) });
    }
    if (request.processedAt) {
      items.push({ label: '处理时间', children: formatBeijingDateTime(String(request.processedAt)) });
    }
    if (request.opinion) {
      items.push({ label: '处理意见', children: String(request.opinion) });
    }
    if (request.cancelSource) {
      items.push({ label: '取消来源', children: CANCEL_SOURCE_LABELS[String(request.cancelSource)] ?? String(request.cancelSource) });
    }
    if (request.cancelledAt) {
      items.push({ label: '取消时间', children: formatBeijingDateTime(String(request.cancelledAt)) });
    }
    if (request.remark) {
      items.push({ label: '整单备注', children: String(request.remark) });
    }
    return items;
  })();

  /** 申请对象列表（hr/asset 详情携带；asset 按申请类型分支渲染，无数据则不渲染区块）。 */
  const objectBlock = (() => {
    const objectDetail = detail?.detail;
    if (service === 'asset') {
      return assetObjectBlock(String(request?.requestType ?? ''), objectDetail);
    }
    if (Array.isArray(objectDetail)) {
      // 加班申请对象：员工 / 日期 / 起止时间 / 原因
      return <Card size="small" title="申请对象">
        <Table<RecordValue> size="small" rowKey={(row) => String(row.id)} pagination={false} dataSource={objectDetail} locale={{ emptyText: '暂无申请对象' }} columns={[
          { key: 'userName', title: '员工', dataIndex: 'userName' },
          { key: 'overtimeDate', title: '加班日期', dataIndex: 'overtimeDate', render: (value) => String(value).slice(0, 10) },
          { key: 'startMinute', title: '开始', dataIndex: 'startMinute', width: 80, render: minuteToTime },
          { key: 'endMinute', title: '结束', dataIndex: 'endMinute', width: 80, render: minuteToTime },
          { key: 'reason', title: '原因', dataIndex: 'reason' },
        ]} />
      </Card>;
    }
    if (isRecord(objectDetail)) {
      // 岗位变更申请对象：员工 / 目标部门 / 目标岗位
      return <Card size="small" title="申请对象">
        <Descriptions bordered column={1} size="small" items={[
          { label: '员工', children: String(objectDetail.userName ?? '—') },
          { label: '目标部门', children: String(objectDetail.targetDepartmentName ?? objectDetail.targetDepartmentId ?? '—') },
          { label: '目标岗位', children: String(objectDetail.targetPositionName ?? objectDetail.targetPositionId ?? '—') },
        ]} />
      </Card>;
    }
    return null;
  })();

  /** 处理记录时间线（提交、取消及各处理人的处理操作；主 PRD §3.2）。 */
  const actionTimeline = <Card size="small" title="处理记录">
    {actions.length > 0
      ? <Timeline items={actions.map((action) => ({
          color: ACTION_COLORS[String(action.action)] ?? 'gray',
          children: <div>
            <Space size="small">
              <Typography.Text strong>{ACTION_LABELS[String(action.action)] ?? String(action.action)}</Typography.Text>
              {action.actorName ? <Typography.Text type="secondary">{String(action.actorName)}</Typography.Text> : null}
            </Space>
            <div><Typography.Text type="secondary">{formatBeijingDateTime(String(action.createdAt))}</Typography.Text></div>
            {action.opinion ? <Typography.Paragraph style={{ marginBottom: 0 }}>{String(action.opinion)}</Typography.Paragraph> : null}
            {action.cancelSource ? <Typography.Text type="secondary">取消来源：{CANCEL_SOURCE_LABELS[String(action.cancelSource)] ?? String(action.cancelSource)}</Typography.Text> : null}
          </div>,
        }))} />
      : <Typography.Text type="secondary">暂无处理记录</Typography.Text>}
  </Card>;

  return <>
    <DataTable
      key={version}
      title={title}
      service={service}
      endpoint="/approval-requests"
      pageKey={pageKey}
      columns={[
        { key: 'requestType', title: '申请类型', sortable: true },
        { key: 'applicantName', title: '申请人', sortable: service !== 'platform' },
        { key: 'status', title: '状态', render: (value) => <StatusTag value={value} />, sortable: true },
        { key: 'submittedAt', title: '提交时间', sortable: service !== 'platform' },
      ]}
      filterFields={[{ key: 'status', title: '状态', type: 'enum', options: [{ label: '待处理', value: 'PENDING' }, { label: '已批准', value: 'APPROVED' }, { label: '已驳回', value: 'REJECTED' }, { label: '已取消', value: 'CANCELLED' }] }, ...(requestTypeOptions.length > 0 ? [{ key: 'requestType', title: '申请类型', type: 'enum' as const, options: requestTypeOptions }] : []), { key: 'keyword', title: '关键字', type: 'text' }]}
      exportConfig={{ allEndpoint: service === 'asset' ? '/approval-requests/export/all' : '/approval-requests/export', filteredEndpoint: service === 'asset' ? '/approval-requests/export/all' : '/approval-requests/export', filename: `${service}-approvals.xlsx`, method: service === 'asset' ? 'GET' : 'POST' }}
      onRowsLoaded={setRows}
      onRowClick={(row) => setCurrentIndex(rows.findIndex((item) => item.id === row.id))}
    />
    <Drawer title="审批详情" open={currentIndex !== null} onClose={() => setCurrentIndex(null)} width="min(92vw, 560px)">
      {detailLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin />正在加载详情...</div>
      ) : detail ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Card size="small" title="申请信息"><Descriptions bordered column={1} size="small" items={infoItems} /></Card>
          {objectBlock}
          {actionTimeline}
          <Form form={form} layout="vertical"><Form.Item name="opinion" label="处理意见（驳回必填）"><Input.TextArea maxLength={500} rows={3} /></Form.Item></Form>
          <Space wrap>
            {current?.status === 'PENDING' ? <><ConfirmAction title="确认批准该申请？" description="批准后申请进入下一处理状态。" okText="批准" onConfirm={() => void process('APPROVE')}><Button type="primary">批准</Button></ConfirmAction><ConfirmAction title="确认驳回该申请？" description="驳回后申请结束，请确认已填写驳回原因。" okText="驳回" danger onConfirm={() => void process('REJECT')}><Button danger>驳回</Button></ConfirmAction></> : null}
            {canCancel && current?.status === 'PENDING' ? <Popconfirm title="确认取消该待审批申请？" onConfirm={() => void cancel()}><Button>取消申请</Button></Popconfirm> : null}
            <Button disabled={currentIndex === 0} onClick={() => setCurrentIndex((value) => value === null ? value : value - 1)}>上一条</Button>
            <Button disabled={currentIndex === null || currentIndex >= rows.length - 1} onClick={() => setCurrentIndex((value) => value === null ? value : value + 1)}>下一条</Button>
          </Space>
        </Space>
      ) : <Typography.Text>正在加载...</Typography.Text>}
    </Drawer>
  </>;
}

/** 判断是否为普通对象（审批详情区块构造）。 */
function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** asset 核销类型中文（借还核销/代领结清明细展示）。 */
const WRITE_OFF_TYPE_LABELS: Readonly<Record<string, string>> = {
  LOST: '遗失',
  DAMAGED: '损坏',
};

/** asset 代领结清处理方式中文。 */
const SETTLE_METHOD_LABELS: Readonly<Record<string, string>> = {
  RETURN: '归还',
  WRITE_OFF: '核销',
};

type ObjectColumn = {
  key: string;
  title: string;
  dataIndex?: string;
  width?: number;
  render?: (value: unknown, row: RecordValue) => React.ReactNode;
};

/** 申领/入库/变更明细共用基础列（名称快照而非裸 ID；主 PRD §3.2）。 */
const ASSET_ITEM_BASE_COLUMNS: ObjectColumn[] = [
  { key: 'consumableName', title: '品种', dataIndex: 'consumableName' },
  { key: 'spec', title: '规格', dataIndex: 'spec', width: 90 },
  { key: 'warehouseName', title: '库位', dataIndex: 'warehouseName' },
  { key: 'qty', title: '数量', dataIndex: 'qty', width: 70 },
];

/** 借还/结清明细取嵌套借还记录快照列（borrowRecord.xxx）。 */
function borrowRecordColumn(key: string, title: string): ObjectColumn {
  return {
    key,
    title,
    render: (_value, row) => String(isRecord(row.borrowRecord) ? row.borrowRecord[key] ?? '—' : '—'),
  };
}

/** 申请对象明细表（行 id 兜底数组序号）。 */
function objectTable(rows: RecordValue[], columns: ObjectColumn[]): React.ReactNode {
  return <Table<RecordValue> size="small" rowKey={(row) => String(row.id ?? rows.indexOf(row))} pagination={false}
    dataSource={rows} locale={{ emptyText: '暂无申请对象' }} columns={columns} />;
}

/** 借还/结清明细表（借还记录快照 + 申请数量 + 各类型专有列）。 */
function assetBorrowItemTable(rows: RecordValue[], extra: ObjectColumn[]): React.ReactNode {
  return objectTable(rows, [
    borrowRecordColumn('consumableName', '品种'),
    borrowRecordColumn('spec', '规格'),
    borrowRecordColumn('warehouseName', '库位'),
    borrowRecordColumn('userName', '借用人'),
    { key: 'qty', title: '数量', dataIndex: 'qty', width: 70 },
    ...extra,
  ]);
}

/** asset 申请对象区块（按申请类型分支；无匹配类型或无数据返回 null）。 */
function assetObjectBlock(requestType: string, objectDetail: unknown): React.ReactNode {
  const label = (value: unknown, labels: Readonly<Record<string, string>>) =>
    value === null || value === undefined || value === '' ? '—' : labels[String(value)] ?? String(value);
  const dateOnly = (value: unknown) => String(value ?? '').slice(0, 10) || '—';
  switch (requestType) {
    case 'STOCK_IN':
      return Array.isArray(objectDetail) ? <Card size="small" title="申请对象">{objectTable(objectDetail, [
        ...ASSET_ITEM_BASE_COLUMNS,
        { key: 'unitPrice', title: '单价', dataIndex: 'unitPrice', width: 90 },
        { key: 'supplierName', title: '供应商', dataIndex: 'supplierName' },
        { key: 'brandName', title: '品牌', dataIndex: 'brandName' },
        { key: 'receivedAt', title: '入库日期', dataIndex: 'receivedAt', render: dateOnly, width: 110 },
      ])}</Card> : null;
    case 'STOCK_CHANGE':
      return Array.isArray(objectDetail) ? <Card size="small" title="申请对象">{objectTable(objectDetail, [
        ...ASSET_ITEM_BASE_COLUMNS,
        { key: 'changeTypeName', title: '变更类型', dataIndex: 'changeTypeName' },
        { key: 'reason', title: '原因', dataIndex: 'reason' },
        { key: 'changedAt', title: '变更时间', dataIndex: 'changedAt', render: (value) => formatBeijingDateTime(String(value ?? '')), width: 150 },
      ])}</Card> : null;
    case 'CONSUMABLE_REQUEST':
      return Array.isArray(objectDetail) ? <Card size="small" title="申请对象">{objectTable(objectDetail, [
        ...ASSET_ITEM_BASE_COLUMNS,
        { key: 'purpose', title: '用途', dataIndex: 'purpose' },
      ])}</Card> : null;
    case 'AGENT_REQUEST': {
      // 代领申请对象 = 共享申领清单 + 受领人名单
      if (!isRecord(objectDetail)) return null;
      const items = Array.isArray(objectDetail.items) ? objectDetail.items : [];
      const recipients = Array.isArray(objectDetail.recipients) ? objectDetail.recipients : [];
      return <Card size="small" title="申请对象">
        <Typography.Text type="secondary">申领明细</Typography.Text>
        {objectTable(items, [...ASSET_ITEM_BASE_COLUMNS, { key: 'purpose', title: '用途', dataIndex: 'purpose' }])}
        <Typography.Text type="secondary">受领人</Typography.Text>
        {objectTable(recipients, [{ key: 'userName', title: '姓名', dataIndex: 'userName' }])}
      </Card>;
    }
    case 'RETURN':
      return Array.isArray(objectDetail) ? <Card size="small" title="申请对象">{assetBorrowItemTable(objectDetail, [])}</Card> : null;
    case 'WRITE_OFF':
      return Array.isArray(objectDetail) ? <Card size="small" title="申请对象">{assetBorrowItemTable(objectDetail, [
        { key: 'writeOffType', title: '核销类型', dataIndex: 'writeOffType', render: (value) => label(value, WRITE_OFF_TYPE_LABELS), width: 90 },
        { key: 'reason', title: '原因', dataIndex: 'reason' },
      ])}</Card> : null;
    case 'AGENT_SETTLEMENT':
      return Array.isArray(objectDetail) ? <Card size="small" title="申请对象">{assetBorrowItemTable(objectDetail, [
        { key: 'method', title: '处理方式', dataIndex: 'method', render: (value) => label(value, SETTLE_METHOD_LABELS), width: 90 },
        { key: 'writeOffType', title: '核销类型', dataIndex: 'writeOffType', render: (value) => label(value, WRITE_OFF_TYPE_LABELS), width: 90 },
        { key: 'reason', title: '原因', dataIndex: 'reason' },
      ])}</Card> : null;
    default:
      return null;
  }
}
