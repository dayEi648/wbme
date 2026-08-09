import { Button, Drawer, Form, Input, Popconfirm, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { DataTable, StatusTag } from './DataTable';
import { useFeedback } from '../request/feedback';
import { http, type ApiService } from '../request/http';
import { useSession } from '../request/session';

type RecordValue = Record<string, unknown>;

interface ApprovalCenterProps {
  title: string;
  service: ApiService;
  pageKey: string;
}

/**
 * 统一审批中心：在当前页面抽屉展示详情、处理时间线和待办前后切换。
 * 处理请求只提交服务端允许的 action/opinion，状态机、范围与并发由后端最终校验。
 */
export function ApprovalCenter({ title, service, pageKey }: ApprovalCenterProps) {
  const feedback = useFeedback();
  const { user } = useSession();
  const [rows, setRows] = useState<RecordValue[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [detail, setDetail] = useState<RecordValue | null>(null);
  const [version, setVersion] = useState(0);
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

  useEffect(() => {
    if (!current?.id) {
      setDetail(null);
      return;
    }
    void http.get<RecordValue>(`/approval-requests/${String(current.id)}`, { service, active: true }).then(setDetail).catch((error) => feedback.error(error, '审批详情加载失败'));
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

  return <>
    <DataTable
      key={version}
      title={title}
      description="点击待办在当前页打开详情抽屉，可直接批准、驳回或切换上一条/下一条。"
      service={service}
      endpoint="/approval-requests"
      pageKey={pageKey}
      columns={[
        { key: 'id', title: 'ID', fixed: 'left' },
        { key: 'requestType', title: '申请类型' },
        { key: 'applicantName', title: '申请人' },
        { key: 'status', title: '状态', render: (value) => <StatusTag value={value} /> },
        { key: 'submittedAt', title: '提交时间' },
      ]}
      filterFields={[{ key: 'status', title: '状态', type: 'enum', options: [{ label: '待处理', value: 'PENDING' }, { label: '已批准', value: 'APPROVED' }, { label: '已驳回', value: 'REJECTED' }, { label: '已取消', value: 'CANCELLED' }] }, ...(requestTypeOptions.length > 0 ? [{ key: 'requestType', title: '申请类型', type: 'enum' as const, options: requestTypeOptions }] : []), { key: 'keyword', title: '关键字', type: 'text' }]}
      exportConfig={{ allEndpoint: service === 'asset' ? '/approval-requests/export/all' : '/approval-requests/export', filteredEndpoint: service === 'asset' ? '/approval-requests/export/all' : '/approval-requests/export', filename: `${service}-approvals.xlsx`, method: service === 'asset' ? 'GET' : 'POST' }}
      onRowsLoaded={setRows}
      onRowClick={(row) => setCurrentIndex(rows.findIndex((item) => item.id === row.id))}
    />
    <Drawer title="审批详情" open={currentIndex !== null} onClose={() => setCurrentIndex(null)} width={560}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {detail ? Object.entries(detail).map(([key, value]) => <div key={key}><Typography.Text type="secondary">{key}</Typography.Text><Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</Typography.Paragraph></div>) : <Typography.Text>正在加载...</Typography.Text>}
        <Form form={form} layout="vertical"><Form.Item name="opinion" label="处理意见（驳回必填）"><Input.TextArea maxLength={500} rows={3} /></Form.Item></Form>
        <Space wrap>
          {current?.status === 'PENDING' ? <><Button type="primary" onClick={() => void process('APPROVE')}>批准</Button><Button danger onClick={() => void process('REJECT')}>驳回</Button></> : null}
          {canCancel && current?.status === 'PENDING' ? <Popconfirm title="确认取消该待审批申请？" onConfirm={() => void cancel()}><Button>取消申请</Button></Popconfirm> : null}
          <Button disabled={currentIndex === 0} onClick={() => setCurrentIndex((value) => value === null ? value : value - 1)}>上一条</Button>
          <Button disabled={currentIndex === null || currentIndex >= rows.length - 1} onClick={() => setCurrentIndex((value) => value === null ? value : value + 1)}>下一条</Button>
        </Space>
      </Space>
    </Drawer>
  </>;
}
