import { Button, Card, Drawer, Form, Input, Popconfirm, Space, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppShell, type NavigationItem } from '../../components/AppShell';
import { ApprovalCenter } from '../../components/ApprovalCenter';
import { DataTable, StatusTag } from '../../components/DataTable';
import { ResourcePage } from '../../components/ResourcePage';
import { ResourceFormModal, type FormField } from '../../components/ResourceFormModal';
import { SettingsEditor } from '../../components/SettingsEditor';
import { SystemHome } from '../../components/SystemHome';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import { useSession } from '../../request/session';

const NAVIGATION: NavigationItem[] = [
  { key: 'employees', label: '组织成员', path: '/hr/employees', permission: 'org_structure' },
  { key: 'departments', label: '部门管理', path: '/hr/departments', permission: 'department_manage' },
  { key: 'positions', label: '岗位管理', path: '/hr/positions', permission: 'position_manage' },
  { key: 'titles', label: '职称管理', path: '/hr/titles', permission: 'title_manage' },
  { key: 'overtime-apply', label: '加班申请', path: '/hr/overtime-apply', permission: ['overtime_apply', 'proxy_overtime'] },
  { key: 'overtime-mine', label: '我的加班', path: '/hr/overtime-mine', permission: 'overtime_apply' },
  { key: 'overtime-records', label: '加班历史', path: '/hr/overtime-records', permission: 'overtime_history' },
  { key: 'approval', label: '审批中心', path: '/hr/approval', permission: ['overtime_approval', 'org_structure'] },
  { key: 'settings', label: '人事配置', path: '/hr/settings', permission: 'hr_config' },
];

const COMMON_COLUMNS = [
  { key: 'id', title: 'ID', fixed: 'left' as const },
  { key: 'name', title: '名称' },
  { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> },
  { key: 'updatedAt', title: '更新时间' },
];

const TITLE_RULE_FIELDS: FormField[] = [
  { key: 'titleName', label: '职称名称', required: true, maxLength: 100 },
  { key: 'departmentId', label: '匹配部门 ID', type: 'number' },
  { key: 'positionId', label: '匹配岗位 ID', type: 'number' },
  { key: 'roleCondition', label: '匹配站点角色', type: 'select', options: [{ label: '超级管理员', value: 'SUPER_ADMIN' }, { label: '员工', value: 'EMPLOYEE' }] },
  { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] },
  { key: 'sort', label: '排序', type: 'number' },
];

/** 人事系统路由容器。 */
export default function HrPage() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] ?? '';
  const body = useMemo(() => {
    switch (section) {
      case 'employees':
        return <OrganizationEmployees />;
      case 'departments':
        return <ResourcePage title="部门管理" description="维护部门树及启停；删除前应先查看引用确认。" service="hr" endpoint="/departments/tree" pageKey="hr-departments" columns={[...COMMON_COLUMNS, { key: 'parentName', title: '上级部门' }, { key: 'managerName', title: '负责人' }]} create={{ title: '新建部门', endpoint: '/departments', fields: [{ key: 'name', label: '部门名称', required: true, maxLength: 100 }, { key: 'parentId', label: '上级部门 ID', type: 'number' }, { key: 'sort', label: '排序', type: 'number' }] }} edit={{ title: '编辑部门', endpoint: (id) => `/departments/${id}`, fields: [{ key: 'name', label: '部门名称', maxLength: 100 }, { key: 'sort', label: '排序', type: 'number' }, { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }] }} batchDelete={{ endpoint: '/departments/delete', bodyKey: 'ids' }} />;
      case 'positions':
        return <ResourcePage title="岗位管理" description="维护岗位、适用部门及自助申请开关。" service="hr" endpoint="/positions?includeDisabled=true" pageKey="hr-positions" columns={[...COMMON_COLUMNS, { key: 'description', title: '说明' }, { key: 'allowSelfApply', title: '允许自助申请' }, { key: 'departments', title: '适用部门' }]} create={{ title: '新建岗位', endpoint: '/positions', fields: [{ key: 'name', label: '岗位名称', required: true, maxLength: 100 }, { key: 'description', label: '说明', type: 'textarea', maxLength: 500 }, { key: 'allowSelfApply', label: '允许自助申请', type: 'boolean' }, { key: 'departmentIds', label: '适用部门 ID（JSON）', type: 'textarea', maxLength: 1000 }], transform: (values) => ({ ...values, departmentIds: parseIds(values.departmentIds) }) }} edit={{ title: '编辑岗位', endpoint: (id) => `/positions/${id}`, fields: [{ key: 'name', label: '岗位名称', maxLength: 100 }, { key: 'description', label: '说明', type: 'textarea', maxLength: 500 }, { key: 'allowSelfApply', label: '允许自助申请', type: 'boolean' }, { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }, { key: 'sort', label: '排序', type: 'number' }] }} batchDelete={{ endpoint: '/positions/delete', bodyKey: 'ids' }} />;
      case 'titles':
        return <ResourcePage title="职称规则" description="职称为组织和规则实时派生结果，规则变更会立即反映。" service="hr" endpoint="/title-rules" pageKey="hr-title-rules" columns={[...COMMON_COLUMNS, { key: 'titleName', title: '职称' }, { key: 'sort', title: '排序' }, { key: 'conditions', title: '条件' }]} filterFields={[{ key: 'keyword', title: '关键字', type: 'text' }, { key: 'status', title: '状态', type: 'enum', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }]} create={{ title: '新建职称规则', endpoint: '/title-rules', fields: TITLE_RULE_FIELDS }} edit={{ title: '编辑职称规则', endpoint: (id) => `/title-rules/${id}`, fields: TITLE_RULE_FIELDS }} batchDelete={{ endpoint: '/title-rules/delete', bodyKey: 'ids' }} />;
      case 'overtime-apply':
        return <OvertimeApply />;
      case 'overtime-mine':
        return <OvertimeMine />;
      case 'overtime-records':
        return <OvertimeRecords />;
      case 'approval':
        return <ApprovalCenter title="人事审批中心" service="hr" pageKey="hr-approval" />;
      case 'settings':
        return <HrSettings />;
      default:
        return <SystemHome systemName="人事系统" welcome="办理组织架构、岗位职称、加班申请与人事审批。" items={NAVIGATION} />;
    }
  }, [section]);
  return <AppShell systemName="人事系统" homePath="/hr" items={NAVIGATION}>{body}</AppShell>;
}

/** 组织成员维护：部门为并列多选，岗位为单选；两项均由服务端重新校验适用关系。 */
function OrganizationEmployees() {
  const feedback = useFeedback();
  const [target, setTarget] = useState<Record<string, unknown> | null>(null);
  const [mode, setMode] = useState<'departments' | 'position' | null>(null);
  const [version, setVersion] = useState(0);
  const userId = Number(target?.id);
  const saveDepartments = async (values: Record<string, unknown>) => {
    if (!Number.isInteger(userId)) return;
    try {
      await http.put(`/org/employees/${userId}/departments`, { departmentIds: parseIds(values.departmentIds) }, { service: 'hr' });
      feedback.success('员工部门已更新');
      setMode(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '更新员工部门失败');
    }
  };
  const savePosition = async (values: Record<string, unknown>) => {
    if (!Number.isInteger(userId)) return;
    try {
      const positionId = values.positionId === undefined || values.positionId === null || values.positionId === '' ? null : Number(values.positionId);
      await http.put(`/org/employees/${userId}/position`, { positionId }, { service: 'hr' });
      feedback.success('员工岗位已更新');
      setMode(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '更新员工岗位失败');
    }
  };
  return <>
    <DataTable key={version} title="组织成员" description="查看员工部门、岗位与派生职称；部门可多选并列，岗位只能有一个且必须适用于全部当前部门。" service="hr" endpoint="/org/employees" pageKey="hr-employees" columns={[{ key: 'id', title: '员工 ID', fixed: 'left' }, { key: 'name', title: '姓名' }, { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> }, { key: 'departmentNames', title: '部门' }, { key: 'positionName', title: '岗位' }, { key: 'titleName', title: '职称' }]} filterFields={[{ key: 'keyword', title: '姓名关键字', type: 'text' }, { key: 'departmentId', title: '部门 ID', type: 'number' }, { key: 'positionId', title: '岗位 ID', type: 'number' }, { key: 'status', title: '账号状态', type: 'enum', options: [{ label: '在职', value: 'ACTIVE' }, { label: '已注销', value: 'DEACTIVATED' }] }]} onRowClick={setTarget} rowActions={(row) => <Space size="small"><Button size="small" onClick={() => { setTarget(row); setMode('departments'); }}>调整部门</Button><Button size="small" onClick={() => { setTarget(row); setMode('position'); }}>调整岗位</Button></Space>} />
    <Drawer title="组织成员详情" open={target !== null} onClose={() => setTarget(null)} width={520}>{target ? Object.entries(target).map(([key, value]) => <Card key={key} size="small" title={key} style={{ marginBottom: 8 }}>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</Card>) : null}</Drawer>
    <ResourceFormModal title="调整员工部门" open={mode === 'departments'} onCancel={() => setMode(null)} onSubmit={saveDepartments} initialValues={{ departmentIds: JSON.stringify(target?.departmentIds ?? []) }} fields={[{ key: 'departmentIds', label: '部门 ID（JSON 数组，可为空）', type: 'textarea', required: true, maxLength: 2000, placeholder: '[1,2]' }]} />
    <ResourceFormModal title="调整员工岗位" open={mode === 'position'} onCancel={() => setMode(null)} onSubmit={savePosition} initialValues={{ positionId: target?.positionId }} fields={[{ key: 'positionId', label: '岗位 ID（留空清除岗位）', type: 'number' }]} />
  </>;
}

/** 加班申请：提交前读取服务端日期类型，提交时把可读时间转换为后端分钟值。 */
function OvertimeApply() {
  const feedback = useFeedback();
  const { user } = useSession();
  const [form] = Form.useForm<{ overtimeDate: string; startTime: string; endTime: string; reason: string; userIds: string }>();
  const [dateInfo, setDateInfo] = useState<Record<string, unknown> | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) form.setFieldValue('userIds', JSON.stringify([user.id]));
  }, [form, user]);

  const loadDateType = async () => {
    const date = form.getFieldValue('overtimeDate');
    if (!date) return;
    try {
      setDateInfo(await http.get<Record<string, unknown>>(`/overtime/date-type?date=${encodeURIComponent(date)}`, { service: 'hr', active: true }));
    } catch (error) {
      setDateInfo(null);
      feedback.error(error, '加班日期校验失败');
    }
  };

  const submit = async (values: { overtimeDate: string; startTime: string; endTime: string; reason: string; userIds: string }) => {
    const startMinute = toMinute(values.startTime);
    const endMinute = toMinute(values.endTime, true);
    let userIds: number[];
    try {
      userIds = parseIds(values.userIds);
    } catch (error) {
      feedback.error(error, '加班员工格式不正确');
      return;
    }
    if (startMinute === null || endMinute === null || startMinute >= endMinute) {
      feedback.error(new Error('请填写同一自然日内且结束晚于开始的时间段'), '时间段不合法');
      return;
    }
    if (userIds.length === 0) {
      feedback.error(new Error('至少选择一名加班员工'), '请填写加班员工 ID');
      return;
    }
    setSubmitting(true);
    try {
      await http.post('/overtime/applications', { overtimeDate: values.overtimeDate, startMinute, endMinute, reason: values.reason, userIds }, { service: 'hr' });
      feedback.success('加班申请已提交，等待审批');
      form.resetFields(['startTime', 'endTime', 'reason']);
      if (user) form.setFieldValue('userIds', JSON.stringify([user.id]));
    } catch (error) {
      feedback.error(error, '加班申请提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <div><Typography.Title level={3}>加班申请</Typography.Title><Typography.Paragraph type="secondary">同一批次使用同一日期、时间段和事由；服务端会同时校验日期窗口、员工范围与时间重叠，任一员工不通过则整批不提交。</Typography.Paragraph></div>
    <Card>
      <Form form={form} layout="vertical" onFinish={(values) => void submit(values)} initialValues={{ startTime: '18:00', endTime: '20:00' }}>
        <Form.Item name="overtimeDate" label="加班日期" rules={[{ required: true, message: '请选择日期' }]}><Input type="date" onBlur={() => void loadDateType()} /></Form.Item>
        {dateInfo ? <Card size="small" style={{ marginBottom: 16 }}><Typography.Text>日期类型：{String(dateInfo.dateType ?? '—')}；来源：{String(dateInfo.source ?? '—')}。</Typography.Text></Card> : null}
        <Space size="middle" wrap>
          <Form.Item name="startTime" label="开始时间（HH:mm）" rules={[{ required: true }]}><Input placeholder="18:00" inputMode="numeric" /></Form.Item>
          <Form.Item name="endTime" label="结束时间（HH:mm，允许 24:00）" rules={[{ required: true }]}><Input placeholder="20:00 或 24:00" inputMode="numeric" /></Form.Item>
        </Space>
        <Form.Item name="reason" label="加班事由" rules={[{ required: true, message: '请填写加班事由' }, { max: 500 }]}><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item>
        <Form.Item name="userIds" label="加班员工 ID（JSON 数组）" rules={[{ required: true, message: '请至少填写一名员工' }]} extra="仅持有“加班申请”时服务端会固定为本人；有代交权限时可填写授权范围内多名员工。"><Input.TextArea rows={2} maxLength={2000} /></Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting}>提交加班申请</Button>
      </Form>
    </Card>
  </Space>;
}

/** 本人加班记录与当月汇总。 */
function OvertimeMine() {
  const feedback = useFeedback();
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [pendingVersion, setPendingVersion] = useState(0);
  useEffect(() => { void http.get<Record<string, unknown>>('/overtime/mine/summary', { service: 'hr', active: true }).then(setSummary).catch((error) => feedback.error(error, '加班汇总加载失败')); }, [feedback]);
  const cancelPending = async (id: number) => {
    try {
      await http.post(`/overtime/applications/${id}/cancel`, {}, { service: 'hr' });
      feedback.success('加班申请已取消');
      setPendingVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '取消加班申请失败');
    }
  };
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    {summary ? <Card title="本月加班汇总"><Space wrap>{Object.entries(summary).map(([key, value]) => <Typography.Text key={key}>{key}：{String(value ?? '—')}</Typography.Text>)}</Space></Card> : null}
    <DataTable key={pendingVersion} title="待审批加班申请" description="可查看本人提交或代交的待审批批次，并在审批前主动取消。" service="hr" endpoint="/overtime/applications/mine" pageKey="hr-overtime-pending" columns={[{ key: 'id', title: 'ID', fixed: 'left' }, { key: 'applicationNo', title: '申请编号' }, { key: 'overtimeDate', title: '日期' }, { key: 'timeRange', title: '时间段' }, { key: 'employees', title: '员工' }, { key: 'itemCount', title: '人数' }, { key: 'submittedAt', title: '提交时间' }]} filterFields={[{ key: 'month', title: '月份', type: 'text' }]} rowActions={(row) => <Popconfirm title="确认取消该待审批加班申请？" onConfirm={() => void cancelPending(Number(row.id))}><Button size="small" danger>取消申请</Button></Popconfirm>} />
    <DataTable title="我的加班记录" description="查看已批准的本人加班记录和月度汇总。" service="hr" endpoint="/overtime/mine" pageKey="hr-overtime-mine-history" columns={[...COMMON_COLUMNS, { key: 'overtimeDate', title: '日期' }, { key: 'minutes', title: '分钟' }, { key: 'dateType', title: '日期类型' }]} filterFields={[{ key: 'month', title: '月份', type: 'text' }]} />
  </Space>;
}

function HrSettings() {
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <SettingsEditor title="人事运行参数" service="hr" endpoint="/hr-settings" description="加班提前申请与补交窗口即时生效，已提交申请使用各自快照。" save={async (item, value) => { await http.put(`/hr-settings/${item.key}`, { value }, { service: 'hr' }); }} />
    <ResourcePage title="人事字典" service="hr" endpoint="/dicts" pageKey="hr-dicts" columns={[...COMMON_COLUMNS, { key: 'dictType', title: '类型' }]} create={{ title: '新建字典项', endpoint: '/dicts', fields: [{ key: 'dictType', label: '字典类型', required: true }, { key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'sort', label: '排序', type: 'number' }] }} edit={{ title: '编辑字典项', endpoint: (id) => `/dicts/${id}`, fields: [{ key: 'name', label: '名称', maxLength: 100 }, { key: 'sort', label: '排序', type: 'number' }, { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }] }} batchDelete={{ endpoint: '/dicts/delete', bodyKey: 'ids' }} />
  </Space>;
}

/** 加班历史：导出使用统一请求层，以便会话失效和错误反馈与普通 API 一致。 */
function OvertimeRecords() {
  const feedback = useFeedback();
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown>[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  useEffect(() => { void http.get<Record<string, unknown>>('/overtime/records/summary', { service: 'hr', active: true }).then(setSummary).catch((error) => feedback.error(error, '加班管理汇总加载失败')); }, [feedback]);
  const openDetail = async (row: Record<string, unknown>) => {
    const userId = Number(row.id);
    if (!Number.isInteger(userId)) return;
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const month = typeof row.month === 'string' ? `?month=${encodeURIComponent(row.month)}` : '';
      const result = await http.get<{ data: Record<string, unknown>[] }>(`/overtime/records/${userId}${month}`, { service: 'hr', active: true });
      setDetail(result.data);
    } catch (error) {
      setDetail([]);
      feedback.error(error, '加班明细加载失败');
    } finally {
      setDetailLoading(false);
    }
  };
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    {summary ? <Card title="当前月度汇总"><Space wrap>{Object.entries(summary).map(([key, value]) => <Typography.Text key={key}>{key}：{String(value ?? '—')}</Typography.Text>)}</Space></Card> : null}
    <DataTable title="加班历史记录" description="按数据范围查看员工月度加班统计；点击“明细”下钻至该员工的已批准记录。" service="hr" endpoint="/overtime/records" pageKey="hr-overtime-records" columns={[{ key: 'id', title: '员工 ID', fixed: 'left' }, { key: 'name', title: '员工' }, { key: 'minutes', title: '分钟' }, { key: 'hours', title: '小时' }, { key: 'count', title: '次数' }]} filterFields={[{ key: 'month', title: '月份', type: 'text' }, { key: 'keyword', title: '员工关键字', type: 'text' }]} exportConfig={{ allEndpoint: '/overtime/records/export', filename: 'overtime-records.xlsx' }} rowActions={(row) => <Button size="small" onClick={() => void openDetail(row)}>明细</Button>} />
    <Drawer title="加班明细" open={detailOpen} onClose={() => setDetailOpen(false)} width={620} loading={detailLoading}>{detail.length > 0 ? detail.map((item) => <Card key={String(item.id)} size="small" style={{ marginBottom: 8 }} title={String(item.application_no ?? item.applicationNo ?? '加班记录')}><Space direction="vertical"><Typography.Text>日期：{String(item.overtime_date ?? item.overtimeDate ?? '—')}</Typography.Text><Typography.Text>时间：{String(item.start_minute ?? item.startMinute ?? '—')} - {String(item.end_minute ?? item.endMinute ?? '—')}</Typography.Text><Typography.Text>分钟：{String(item.minutes ?? '—')}</Typography.Text><Typography.Text>事由：{String(item.reason ?? '—')}</Typography.Text></Space></Card>) : !detailLoading ? <Typography.Text type="secondary">暂无已批准加班明细。</Typography.Text> : null}</Drawer>
  </Space>;
}

function parseJsonArray(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') throw new Error('员工/部门列表必须是 JSON 数组');
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('员工/部门列表必须是 JSON 数组');
    return parsed;
  } catch {
    throw new Error('JSON 格式不正确，请填写数组');
  }
}

function parseIds(value: unknown): number[] {
  const items = parseJsonArray(value);
  if (!items.every((item) => typeof item === 'number' && Number.isInteger(item) && item > 0)) {
    throw new Error('ID 列表必须是正整数 JSON 数组');
  }
  return items as number[];
}

/** 将表单的 HH:mm 转为后端约定的当日分钟数；仅结束时间允许 24:00。 */
function toMinute(value: string, allowEndOfDay = false): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23) {
    return allowEndOfDay && hour === 24 && minute === 0 ? 1_440 : null;
  }
  return hour * 60 + minute;
}
