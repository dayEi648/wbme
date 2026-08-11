import { Button, Card, Checkbox, DatePicker, Descriptions, Drawer, Form, Input, Space, Table, Tabs, TimePicker, Typography } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AppShell, type NavigationItem } from '../../components/AppShell';
import { ApprovalCenter } from '../../components/ApprovalCenter';
import { DataTable, StatusTag } from '../../components/DataTable';
import { PageTabs } from '../../components/PageTabs';
import { ResourcePage } from '../../components/ResourcePage';
import { ResourceFormModal, type FormField } from '../../components/ResourceFormModal';
import { SettingsEditor } from '../../components/SettingsEditor';
import { SystemHome } from '../../components/SystemHome';
import { RemoteSelect } from '../../components/selectors/RemoteSelect';
import { departmentLeaderEmployeesSource, departmentTreeSource, overtimeEmployeesSource, positionsSource } from '../../components/selectors';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import { useSession } from '../../request/session';

type RecordValue = Record<string, unknown>;

const NAVIGATION: NavigationItem[] = [
  { key: 'employees', label: '组织成员', path: '/hr/employees', permission: 'org_structure', group: '组织架构' },
  { key: 'departments', label: '部门管理', path: '/hr/departments', permission: 'department_manage', group: '组织架构' },
  { key: 'positions', label: '岗位管理', path: '/hr/positions', permission: 'position_manage', group: '组织架构' },
  { key: 'titles', label: '职称管理', path: '/hr/titles', permission: 'title_manage', group: '组织架构' },
  { key: 'overtime', label: '加班申请', path: '/hr/overtime', permission: ['overtime_apply', 'proxy_overtime', 'overtime_history'] },
  { key: 'approval', label: '审批中心', path: '/hr/approval', permission: ['overtime_approval', 'org_structure'] },
  { key: 'settings', label: '系统设置', path: '/hr/settings', permission: 'hr_config' },
];

const COMMON_COLUMNS = [
  { key: 'name', title: '名称' },
  { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> },
  { key: 'updatedAt', title: '更新时间' },
];

/** 人事字典类型中文标签（取值与 contracts HR_DICT_TYPES 对齐；不直接 import DTO 文件，避免 NestJS 进浏览器包） */
const HR_DICT_TYPE_LABELS: Record<string, string> = { PLACEHOLDER: '占位类型' };
const HR_DICT_TYPE_OPTIONS = Object.entries(HR_DICT_TYPE_LABELS).map(([value, label]) => ({ label, value }));
const displayDictType = (value: unknown): string => HR_DICT_TYPE_LABELS[String(value)] ?? String(value ?? '—');

const TITLE_RULE_FIELDS: FormField[] = [
  { key: 'titleName', label: '职称名称', required: true, maxLength: 100 },
  { key: 'departmentId', label: '匹配部门', type: 'tree-select', remote: departmentTreeSource },
  { key: 'positionId', label: '匹配岗位', type: 'remote-select', remote: positionsSource },
  { key: 'roleCondition', label: '匹配站点角色', type: 'select', options: [{ label: '超级管理员', value: 'SUPER_ADMIN' }, { label: '员工', value: 'EMPLOYEE' }] },
  { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }], width: 'narrow' },
  { key: 'sort', label: '排序', type: 'number', width: 'narrow' },
];

const DEPARTMENT_CREATE_FIELDS: FormField[] = [
  { key: 'name', label: '部门名称', required: true, maxLength: 100 },
  { key: 'parentId', label: '上级部门', type: 'tree-select', remote: departmentTreeSource },
  { key: 'leaders', label: '负责人', type: 'remote-multi-select', remote: departmentLeaderEmployeesSource },
  { key: 'sort', label: '排序', type: 'number', width: 'narrow' },
];

const DEPARTMENT_EDIT_FIELDS: FormField[] = [
  { key: 'name', label: '部门名称', maxLength: 100 },
  { key: 'leaders', label: '负责人', type: 'remote-multi-select', remote: departmentLeaderEmployeesSource },
  { key: 'sort', label: '排序', type: 'number', width: 'narrow' },
  { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }], width: 'narrow' },
];

const POSITION_CREATE_FIELDS: FormField[] = [
  { key: 'name', label: '岗位名称', required: true, maxLength: 100 },
  { key: 'description', label: '说明', type: 'textarea', maxLength: 500 },
  { key: 'allowSelfApply', label: '允许自助申请', type: 'boolean' },
  { key: 'departmentIds', label: '适用部门', type: 'tree-multi-select', remote: departmentTreeSource },
];

const POSITION_EDIT_FIELDS: FormField[] = [
  { key: 'name', label: '岗位名称', maxLength: 100 },
  { key: 'description', label: '说明', type: 'textarea', maxLength: 500 },
  { key: 'allowSelfApply', label: '允许自助申请', type: 'boolean' },
  { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }], width: 'narrow' },
  { key: 'sort', label: '排序', type: 'number', width: 'narrow' },
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
        return <HrDepartmentsPage />;
      case 'positions':
        return <ResourcePage title="岗位管理" service="hr" endpoint="/positions?includeDisabled=true" pageKey="hr-positions" columns={[...COMMON_COLUMNS, { key: 'description', title: '说明' }, { key: 'allowSelfApply', title: '允许自助申请' }, { key: 'departments', title: '适用部门' }]} create={{ title: '新建岗位', endpoint: '/positions', fields: POSITION_CREATE_FIELDS, transform: (values) => ({ ...values, departmentIds: Array.isArray(values.departmentIds) ? values.departmentIds.map(Number) : [] }) }} edit={{ title: '编辑岗位', endpoint: (id) => `/positions/${id}`, fields: POSITION_EDIT_FIELDS }} batchDelete={{ endpoint: '/positions/delete', bodyKey: 'ids', previewEndpoint: '/positions/delete-preview', previewItem: (item) => ({ name: `#${String(item.id)}`, refs: `在岗员工 ${String(item.assignedEmployees ?? 0)} 人；待审批申请 ${String(item.pendingRequests ?? 0)} 条；职称规则引用 ${String(item.titleRuleRefs ?? 0)} 条` }) }} />;
      case 'titles':
        return <ResourcePage title="职称规则" service="hr" endpoint="/title-rules" pageKey="hr-title-rules" columns={[...COMMON_COLUMNS, { key: 'titleName', title: '职称' }, { key: 'sort', title: '排序' }, { key: 'conditions', title: '条件' }]} filterFields={[{ key: 'keyword', title: '关键字', type: 'text' }, { key: 'status', title: '状态', type: 'enum', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }]} create={{ title: '新建职称规则', endpoint: '/title-rules', fields: TITLE_RULE_FIELDS }} edit={{ title: '编辑职称规则', endpoint: (id) => `/title-rules/${id}`, fields: TITLE_RULE_FIELDS }} batchDelete={{ endpoint: '/title-rules/delete', bodyKey: 'ids' }} />;
      case 'overtime':
        return <PageTabs items={[
          { key: 'apply', label: '加班申请', permission: ['overtime_apply', 'proxy_overtime'], children: <OvertimeApply /> },
          { key: 'mine', label: '我的加班', permission: 'overtime_apply', children: <OvertimeMine /> },
          { key: 'history', label: '历史记录', permission: 'overtime_history', children: <OvertimeRecords /> },
        ]} />;
      case 'overtime-apply':
        return <Navigate to="/hr/overtime" replace />;
      case 'overtime-mine':
        return <Navigate to="/hr/overtime?tab=mine" replace />;
      case 'overtime-records':
        return <Navigate to="/hr/overtime?tab=history" replace />;
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

/** 部门管理：编辑表单需将列表中的负责人对象映射为 id 数组。 */
function HrDepartmentsPage() {
  const feedback = useFeedback();
  const [editingRow, setEditingRow] = useState<RecordValue | null>(null);
  const [version, setVersion] = useState(0);
  const saveEdit = async (values: RecordValue) => {
    const id = editingRow?.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    try {
      await http.put(`/departments/${id}`, values, { service: 'hr' });
      feedback.success('部门管理已更新');
      setEditingRow(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '更新部门管理失败');
    }
  };
  return <>
    <ResourcePage
      key={version}
      title="部门管理"
      service="hr"
      endpoint="/departments/tree"
      pageKey="hr-departments"
      columns={[...COMMON_COLUMNS, { key: 'parentName', title: '上级部门' }, { key: 'managerName', title: '负责人' }]}
      create={{ title: '新建部门', endpoint: '/departments', fields: DEPARTMENT_CREATE_FIELDS }}
      batchDelete={{ endpoint: '/departments/delete', bodyKey: 'ids', previewEndpoint: '/departments/delete-preview', previewItem: (item) => ({ name: String(item.name ?? '—'), refs: `在职员工 ${String(item.activeEmployees ?? 0)} 人；现存资产 ${String(item.assetCount ?? 0)} 个；待审批申请 ${String(item.pendingRequests ?? 0)} 条；职称规则引用 ${String(item.titleRuleRefs ?? 0)} 条` }) }}
      rowActions={(row) => <Button size="small" onClick={() => setEditingRow(row)}>编辑</Button>}
    />
    <ResourceFormModal
      title="编辑部门"
      open={editingRow !== null}
      onCancel={() => setEditingRow(null)}
      onSubmit={saveEdit}
      fields={DEPARTMENT_EDIT_FIELDS}
      initialValues={editingRow ? mapDepartmentEditValues(editingRow) : {}}
    />
  </>;
}

/** 组织成员维护：部门为并列多选，岗位为单选；两项均由服务端重新校验适用关系。 */
function OrganizationEmployees() {
  const feedback = useFeedback();
  const [target, setTarget] = useState<RecordValue | null>(null);
  const [mode, setMode] = useState<'departments' | 'position' | null>(null);
  const [version, setVersion] = useState(0);
  const userId = Number(target?.id);
  const saveDepartments = async (values: RecordValue) => {
    if (!Number.isInteger(userId)) return;
    try {
      await http.put(`/org/employees/${userId}/departments`, { departmentIds: Array.isArray(values.departmentIds) ? values.departmentIds.map(Number) : [] }, { service: 'hr' });
      feedback.success('员工部门已更新');
      setMode(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '更新员工部门失败');
    }
  };
  const savePosition = async (values: RecordValue) => {
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
  const detailItems = target ? [
    { label: '姓名', children: String(target.name ?? '—') },
    { label: '状态', children: <StatusTag value={target.status} /> },
    { label: '部门', children: Array.isArray(target.departmentNames) ? target.departmentNames.join('、') : String(target.departmentNames ?? '—') },
    { label: '岗位', children: String(target.positionName ?? '—') },
    { label: '职称', children: String(target.titleName ?? '—') },
  ] : [];
  return <>
    <DataTable key={version} title="组织成员" service="hr" endpoint="/org/employees" pageKey="hr-employees" columns={[{ key: 'name', title: '姓名' }, { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> }, { key: 'departmentNames', title: '部门' }, { key: 'positionName', title: '岗位' }, { key: 'titleName', title: '职称' }]} filterFields={[{ key: 'keyword', title: '姓名关键字', type: 'text' }, { key: 'departmentId', title: '部门', type: 'tree', remote: departmentTreeSource }, { key: 'positionId', title: '岗位', type: 'remote', remote: positionsSource }, { key: 'status', title: '账号状态', type: 'enum', options: [{ label: '在职', value: 'ACTIVE' }, { label: '已注销', value: 'DEACTIVATED' }] }]} onRowClick={setTarget} rowActions={(row) => <Space size="small"><Button size="small" onClick={() => { setTarget(row); setMode('departments'); }}>调整部门</Button><Button size="small" onClick={() => { setTarget(row); setMode('position'); }}>调整岗位</Button></Space>} />
    <Drawer title="组织成员详情" open={target !== null} onClose={() => setTarget(null)} width="min(92vw, 520px)"><Descriptions bordered column={1} size="small" items={detailItems} /></Drawer>
    <ResourceFormModal title="调整员工部门" open={mode === 'departments'} onCancel={() => setMode(null)} onSubmit={saveDepartments} initialValues={{ departmentIds: Array.isArray(target?.departmentIds) ? target.departmentIds : [] }} fields={[{ key: 'departmentIds', label: '部门', type: 'tree-multi-select', remote: departmentTreeSource, required: true }]} />
    <ResourceFormModal title="调整员工岗位" open={mode === 'position'} onCancel={() => setMode(null)} onSubmit={savePosition} initialValues={{ positionId: target?.positionId }} fields={[{ key: 'positionId', label: '岗位', type: 'remote-select', remote: positionsSource, width: 'full' }]} />
  </>;
}

/** 加班申请：提交前读取服务端日期类型（校验失败即提示，不展示调试信息）。 */
function OvertimeApply() {
  const feedback = useFeedback();
  const { user } = useSession();
  const [form] = Form.useForm<{
    overtimeDate: string;
    startTime: string;
    endTime: string;
    endAtMidnight: boolean;
    reason: string;
    userIds: number[];
  }>();
  const [submitting, setSubmitting] = useState(false);
  const endAtMidnight = Form.useWatch('endAtMidnight', form);

  useEffect(() => {
    if (user) form.setFieldValue('userIds', [user.id]);
  }, [form, user]);

  const loadDateType = async () => {
    const date = form.getFieldValue('overtimeDate');
    if (!date) return;
    try {
      await http.get<RecordValue>(`/overtime/date-type?date=${encodeURIComponent(date)}`, { service: 'hr', active: true });
    } catch (error) {
      feedback.error(error, '加班日期校验失败');
    }
  };

  const submit = async (values: {
    overtimeDate: string;
    startTime: string;
    endTime: string;
    endAtMidnight: boolean;
    reason: string;
    userIds: number[];
  }) => {
    const startMinute = toMinute(values.startTime);
    const endMinute = values.endAtMidnight ? 1_440 : toMinute(values.endTime, true);
    const userIds = Array.isArray(values.userIds) ? values.userIds.map(Number) : [];
    if (startMinute === null || endMinute === null || startMinute >= endMinute) {
      feedback.error(new Error('请填写同一自然日内且结束晚于开始的时间段'), '时间段不合法');
      return;
    }
    if (userIds.length === 0) {
      feedback.error(new Error('至少选择一名加班员工'), '请填写加班员工');
      return;
    }
    setSubmitting(true);
    try {
      await http.post('/overtime/applications', { overtimeDate: values.overtimeDate, startMinute, endMinute, reason: values.reason, userIds }, { service: 'hr' });
      feedback.success('加班申请已提交，等待审批');
      form.resetFields(['startTime', 'endTime', 'endAtMidnight', 'reason']);
      if (user) form.setFieldValue('userIds', [user.id]);
    } catch (error) {
      feedback.error(error, '加班申请提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <Card>
      <Form form={form} layout="vertical" onFinish={(values) => void submit(values)} initialValues={{ startTime: '18:00', endTime: '20:00', endAtMidnight: false }}>
        <Form.Item
          name="overtimeDate"
          label="加班日期"
          rules={[{ required: true, message: '请选择日期' }]}
          getValueProps={(value) => ({ value: value ? dayjs(value, 'YYYY-MM-DD') : undefined })}
          getValueFromEvent={(date) => date?.format('YYYY-MM-DD') ?? ''}
        >
          <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} onChange={() => void loadDateType()} />
        </Form.Item>
        <Space size="middle" wrap align="start">
          <Form.Item
            name="startTime"
            label="开始时间"
            rules={[{ required: true, message: '请选择开始时间' }]}
            getValueProps={(value) => ({ value: value ? dayjs(value, 'HH:mm') : undefined })}
            getValueFromEvent={(time) => time?.format('HH:mm') ?? ''}
          >
            <TimePicker format="HH:mm" needConfirm={false} />
          </Form.Item>
          <Form.Item
            name="endTime"
            label="结束时间"
            rules={[{ required: !endAtMidnight, message: '请选择结束时间' }]}
            getValueProps={(value) => ({ value: value ? dayjs(value, 'HH:mm') : undefined })}
            getValueFromEvent={(time) => time?.format('HH:mm') ?? ''}
          >
            <TimePicker format="HH:mm" needConfirm={false} disabled={endAtMidnight} />
          </Form.Item>
          <Form.Item name="endAtMidnight" valuePropName="checked" label=" ">
            <Checkbox>结束于 24:00</Checkbox>
          </Form.Item>
        </Space>
        <Form.Item name="reason" label="加班事由" rules={[{ required: true, message: '请填写加班事由' }, { max: 500 }]}><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item>
        <Form.Item name="userIds" label="加班员工" rules={[{ required: true, message: '请至少选择一名员工' }]} extra={'仅持有"加班申请"时服务端会固定为本人；有代交权限时可选择授权范围内多名员工。'}>
          <RemoteSelect mode="multiple" source={overtimeEmployeesSource} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting}>提交加班申请</Button>
      </Form>
    </Card>
  </Space>;
}

/** 我的加班：月度汇总（中文标签）+ 本人加班记录；待审批批次在审批中心统一处理。 */
function OvertimeMine() {
  const feedback = useFeedback();
  const [summary, setSummary] = useState<{ items?: Array<RecordValue>; totalMinutes?: number; totalHours?: number } | null>(null);
  useEffect(() => { void http.get<{ items?: Array<RecordValue>; totalMinutes?: number; totalHours?: number }>('/overtime/mine/summary', { service: 'hr', active: true }).then(setSummary).catch((error) => feedback.error(error, '加班汇总加载失败')); }, [feedback]);
  const items = Array.isArray(summary?.items) ? summary.items : [];
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    {summary ? <Card size="small" title="本月加班汇总">
      <Space size={32} wrap>
        <div><Typography.Text type="secondary">累计加班</Typography.Text><div style={{ fontSize: 20, fontWeight: 600 }}>{String(summary.totalHours ?? '—')} 小时</div></div>
        <div><Typography.Text type="secondary">累计分钟</Typography.Text><div style={{ fontSize: 20, fontWeight: 600 }}>{String(summary.totalMinutes ?? '—')} 分钟</div></div>
        <div><Typography.Text type="secondary">加班天数</Typography.Text><div style={{ fontSize: 20, fontWeight: 600 }}>{items.length} 天</div></div>
      </Space>
    </Card> : null}
    <Card size="small" title="每日明细" styles={{ body: { padding: 0 } }}>
      <Table<RecordValue> size="small" rowKey={(row) => String(row.overtimeDate)} pagination={false} dataSource={items} locale={{ emptyText: '本月暂无已批准加班' }} columns={[
        { key: 'overtimeDate', title: '日期', dataIndex: 'overtimeDate' },
        { key: 'hours', title: '小时', dataIndex: 'hours' },
        { key: 'minutes', title: '分钟', dataIndex: 'minutes' },
        { key: 'dateType', title: '日期类型', dataIndex: 'dateType' },
      ]} />
    </Card>
    <DataTable title="我的加班记录" service="hr" endpoint="/overtime/mine" pageKey="hr-overtime-mine-history" columns={[...COMMON_COLUMNS, { key: 'overtimeDate', title: '日期' }, { key: 'minutes', title: '分钟' }, { key: 'dateType', title: '日期类型' }]} filterFields={[{ key: 'month', title: '月份', type: 'text' }]} />
  </Space>;
}

function HrSettings() {
  return <Card>
    <Tabs items={[
      { key: 'params', label: '运行参数', children: <SettingsEditor title="人事运行参数" service="hr" endpoint="/hr-settings" save={async (item, value) => { await http.put(`/hr-settings/${item.key}`, { value }, { service: 'hr' }); }} /> },
      { key: 'dicts', label: '人事字典', children: <ResourcePage title="人事字典" service="hr" endpoint="/dicts" pageKey="hr-dicts" columns={[...COMMON_COLUMNS, { key: 'dictType', title: '类型', render: (value: unknown) => displayDictType(value) }]} create={{ title: '新建字典项', endpoint: '/dicts', fields: [{ key: 'dictType', label: '字典类型', type: 'select' as const, options: HR_DICT_TYPE_OPTIONS, required: true }, { key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'sort', label: '排序', type: 'number' as const, width: 'narrow' as const }] }} edit={{ title: '编辑字典项', endpoint: (id) => `/dicts/${id}`, fields: [{ key: 'name', label: '名称', maxLength: 100 }, { key: 'sort', label: '排序', type: 'number', width: 'narrow' }, { key: 'status', label: '状态', type: 'select', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }], width: 'narrow' }] }} batchDelete={{ endpoint: '/dicts/delete', bodyKey: 'ids', previewEndpoint: '/dicts/delete-preview', previewItem: (item) => ({ name: String(item.name ?? '—'), refs: `业务引用 ${String(item.referencedCount ?? 0)} 条` }) }} /> },
    ]} />
  </Card>;
}

/** 加班历史：页头统计条 + 员工月度统计；明细时间按 HH:mm 展示（批次 4-12）。 */
function OvertimeRecords() {
  const feedback = useFeedback();
  const [summary, setSummary] = useState<RecordValue | null>(null);
  const [detail, setDetail] = useState<RecordValue[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  useEffect(() => { void http.get<RecordValue>('/overtime/records/summary', { service: 'hr', active: true }).then(setSummary).catch((error) => feedback.error(error, '加班管理汇总加载失败')); }, [feedback]);
  const openDetail = async (row: RecordValue) => {
    const userId = Number(row.id);
    if (!Number.isInteger(userId)) return;
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const month = typeof row.month === 'string' ? `?month=${encodeURIComponent(row.month)}` : '';
      const result = await http.get<{ data: RecordValue[] }>(`/overtime/records/${userId}${month}`, { service: 'hr', active: true });
      setDetail(result.data);
    } catch (error) {
      setDetail([]);
      feedback.error(error, '加班明细加载失败');
    } finally {
      setDetailLoading(false);
    }
  };
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    {summary ? <Card size="small" title="当前月度汇总">
      <Space size={32} wrap>
        <div><Typography.Text type="secondary">覆盖员工</Typography.Text><div style={{ fontSize: 20, fontWeight: 600 }}>{String(summary.employeeCount ?? '—')} 人</div></div>
        <div><Typography.Text type="secondary">累计加班</Typography.Text><div style={{ fontSize: 20, fontWeight: 600 }}>{String(summary.totalHours ?? '—')} 小时</div></div>
        <div><Typography.Text type="secondary">累计分钟</Typography.Text><div style={{ fontSize: 20, fontWeight: 600 }}>{String(summary.totalMinutes ?? '—')} 分钟</div></div>
      </Space>
    </Card> : null}
    <DataTable title="加班历史记录" service="hr" endpoint="/overtime/records" pageKey="hr-overtime-records" columns={[{ key: 'name', title: '员工' }, { key: 'minutes', title: '分钟' }, { key: 'hours', title: '小时' }, { key: 'count', title: '次数' }]} filterFields={[{ key: 'month', title: '月份', type: 'text' }, { key: 'keyword', title: '员工关键字', type: 'text' }]} exportConfig={{ allEndpoint: '/overtime/records/export', filename: 'overtime-records.xlsx' }} rowActions={(row) => <Button size="small" onClick={() => void openDetail(row)}>明细</Button>} />
    <Drawer title="加班明细" open={detailOpen} onClose={() => setDetailOpen(false)} width="min(92vw, 620px)" loading={detailLoading}>
      {detail.length > 0 ? <Table<RecordValue> size="small" rowKey={(row) => String(row.id ?? row.applicationNo ?? row.overtimeDate)} dataSource={detail} pagination={false} locale={{ emptyText: '暂无已批准加班明细' }} columns={[
        { key: 'overtimeDate', title: '日期', render: (value: unknown, row: RecordValue) => String(row.overtime_date ?? row.overtimeDate ?? value ?? '—') },
        { key: 'timeRange', title: '时间段', render: (_: unknown, row: RecordValue) => `${toClock(row.start_minute ?? row.startMinute)} - ${toClock(row.end_minute ?? row.endMinute)}` },
        { key: 'minutes', title: '分钟', render: (value: unknown, row: RecordValue) => String(row.minutes ?? value ?? '—') },
        { key: 'reason', title: '事由', render: (value: unknown, row: RecordValue) => String(row.reason ?? value ?? '—') },
      ]} /> : !detailLoading ? <Typography.Text type="secondary">暂无已批准加班明细。</Typography.Text> : null}
    </Drawer>
  </Space>;
}

function mapDepartmentEditValues(row: RecordValue): Record<string, unknown> {
  const leaders = Array.isArray(row.leaders)
    ? row.leaders
      .map((item) => {
        if (typeof item === 'object' && item !== null && 'userId' in item) return Number((item as RecordValue).userId);
        if (typeof item === 'number') return item;
        return NaN;
      })
      .filter((id) => Number.isInteger(id) && id > 0)
    : [];
  return {
    name: row.name,
    sort: row.sort,
    status: row.status,
    leaders,
  };
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

/** 后端分钟数 → HH:mm（24:00 表示为 24:00）。 */
function toClock(value: unknown): string {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1_440) return String(value ?? '—');
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
