import { Breadcrumb, Button, Card, Descriptions, Divider, Drawer, Form, Input, Radio, Select, Space, Typography } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DataTable, StatusTag } from '../../components/DataTable';
import { HistoryNavButtons } from '../../components/HistoryNavButtons';
import { catalogFunctionOptions } from '../../permission/catalog';
import { ApiError, http } from '../../request/http';
import { useFeedback } from '../../request/feedback';

interface MeData {
  user: {
    id: number;
    name: string;
    gender: 'MALE' | 'FEMALE';
    phoneMasked: string;
    status: string;
    isSuperAdmin: boolean;
    createdAt: string;
  };
  departments: unknown[];
  positions: unknown[];
  canApplyPositionChange: boolean;
  pendingProfileChange: boolean;
}

/**
 * 个人中心（base PRD §6）：身份信息（手机号只读）、资料修改（超管直改/员工审批）、
 * 修改密码（成功后全部会话失效）；岗位申请记录与操作日志为独立页面。
 */
export default function MePage() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] ?? '';
  /** 软刷新：重挂载当前子页面重新拉数。 */
  const [refreshKey, setRefreshKey] = useState(0);
  const body = useMemo(() => {
    switch (section) {
      case 'position-applications':
        return <PositionApplications />;
      case 'operation-logs':
        return <OperationLogsPage />;
      default:
        return <MeHome />;
    }
  }, [section]);
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <div style={{ marginBottom: 8 }}>
        <HistoryNavButtons onRefresh={() => setRefreshKey((value) => value + 1)} />
      </div>
      <div key={refreshKey}>{body}</div>
    </div>
  );
}

/** 个人中心主页：身份信息 / 资料修改 / 修改密码 / 岗位变更申请。 */
function MeHome() {
  const feedback = useFeedback();
  const navigate = useNavigate();
  const [me, setMe] = useState<MeData | null>(null);
  const [profileForm] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [positionOpen, setPositionOpen] = useState(false);
  const [positionSubmitting, setPositionSubmitting] = useState(false);
  const [positionOptions, setPositionOptions] = useState<{ departments: Array<{ id: number; name: string }>; positions: Array<{ id: number; name: string; departmentIds: number[] }> }>({ departments: [], positions: [] });
  const [positionOptionsLoading, setPositionOptionsLoading] = useState(false);
  const [positionForm] = Form.useForm<{ targetDepartmentId: number; targetPositionId: number }>();

  useEffect(() => {
    void http
      .get<MeData>('/me', { active: true })
      .then((data) => {
        setMe(data);
        profileForm.setFieldsValue({ name: data.user.name, gender: data.user.gender });
      })
      .catch((error) => {
        if (error instanceof ApiError) {
          feedback.error(error);
        }
      });
  }, [feedback, profileForm]);

  async function submitProfile(values: { name: string; gender: 'MALE' | 'FEMALE' }) {
    setProfileSubmitting(true);
    try {
      const result = await http.put<{ applied: boolean; requestId?: number }>('/me/profile', values);
      if (result.applied) {
        feedback.success('资料已更新');
      } else {
        feedback.success('资料修改申请已提交，等待管理员审批');
      }
      // 超管直改立即生效：同步刷新身份信息卡
      setMe((prev) =>
        prev
          ? {
              ...prev,
              user: { ...prev.user, name: values.name, gender: values.gender },
              pendingProfileChange: !result.applied || prev.pendingProfileChange,
            }
          : prev,
      );
    } catch (error) {
      if (error instanceof ApiError) {
        feedback.error(error);
      }
    } finally {
      setProfileSubmitting(false);
    }
  }

  async function changePassword(values: { currentPassword: string; newPassword: string; confirmPassword: string }) {
    if (values.newPassword !== values.confirmPassword) {
      feedback.error(new Error('两次输入的密码不一致'), '两次输入的密码不一致');
      return;
    }
    setPasswordSubmitting(true);
    try {
      await http.post('/auth/password/change', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        confirmPassword: values.confirmPassword,
      });
      feedback.success('密码已修改，请重新登录');
      navigate('/login', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        feedback.error(error);
      }
    } finally {
      setPasswordSubmitting(false);
    }
  }

  async function submitPositionApplication(values: { targetDepartmentId: number; targetPositionId: number }) {
    setPositionSubmitting(true);
    try {
      await http.post('/me/position-applications', values);
      feedback.success('岗位申请已提交，等待审批');
      setPositionOpen(false);
    } catch (error) {
      feedback.error(error, '岗位申请提交失败');
    } finally {
      setPositionSubmitting(false);
    }
  }

  async function openPositionApplication() {
    setPositionOpen(true);
    setPositionOptionsLoading(true);
    try {
      const options = await http.get<{ departments: Array<{ id: number; name: string }>; positions: Array<{ id: number; name: string; departmentIds: number[] }> }>('/self-service/position-application-options', { service: 'hr', active: true });
      setPositionOptions(options);
    } catch (error) {
      feedback.error(error, '岗位申请选项加载失败');
    } finally {
      setPositionOptionsLoading(false);
    }
  }

  const selectedDepartmentId = Form.useWatch('targetDepartmentId', positionForm);
  const positionSelectOptions = positionOptions.positions
    .filter((position) => selectedDepartmentId === undefined || position.departmentIds.includes(selectedDepartmentId))
    .map((position) => ({ label: position.name, value: position.id }));

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[{ title: '门户', href: '/portal' }, { title: '个人中心' }]} />
      <Typography.Title level={3} style={{ margin: 0 }}>个人中心</Typography.Title>

      <Card title="身份信息">
        <Descriptions column={2} size="small">
          <Descriptions.Item label="姓名">{me?.user.name}</Descriptions.Item>
          <Descriptions.Item label="性别">{me?.user.gender === 'MALE' ? '男' : '女'}</Descriptions.Item>
          <Descriptions.Item label="手机号">{me?.user.phoneMasked}</Descriptions.Item>
          <Descriptions.Item label="账号状态">{me?.user.status === 'ACTIVE' ? '正常' : me?.user.status}</Descriptions.Item>
          <Descriptions.Item label="部门">{me?.departments.map((item) => String((item as { name?: unknown }).name ?? '')).filter(Boolean).join('、') || '—'}</Descriptions.Item>
          <Descriptions.Item label="岗位">{me?.positions.map((item) => String((item as { name?: unknown }).name ?? '')).filter(Boolean).join('、') || '—'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title="资料修改"
        extra={
          me?.pendingProfileChange ? <Typography.Text type="warning">已有待审批申请</Typography.Text> : null
        }
      >
        <Form form={profileForm} layout="vertical" onFinish={submitProfile} requiredMark={false}>
          <Space size="large" align="start">
            <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }, { max: 50 }]}>
              <Input style={{ width: 200 }} maxLength={50} />
            </Form.Item>
            <Form.Item name="gender" label="性别" rules={[{ required: true }]}>
              <Radio.Group>
                <Radio value="MALE">男</Radio>
                <Radio value="FEMALE">女</Radio>
              </Radio.Group>
            </Form.Item>
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            {me?.user.isSuperAdmin ? '超级管理员修改立即生效' : '普通员工提交后需管理员审批通过才生效；手机号以钉钉为准，不可修改'}
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" loading={profileSubmitting} disabled={me?.pendingProfileChange}>
            提交修改
          </Button>
        </Form>
      </Card>

      <Card title="修改密码" extra={<KeyOutlined />}>
        <Form form={passwordForm} layout="vertical" onFinish={changePassword} requiredMark={false}>
          <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password style={{ width: 300 }} autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 8, max: 32, message: '密码需 8~32 个字符' }]}>
            <Input.Password style={{ width: 300 }} />
          </Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码" rules={[{ required: true, min: 8, max: 32 }]}>
            <Input.Password style={{ width: 300 }} />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            修改成功后全部登录状态失效，需重新登录
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" loading={passwordSubmitting}>
            修改密码
          </Button>
        </Form>
      </Card>

      <Divider />
      <Space direction="vertical" size="small">
        <Button disabled={!me?.canApplyPositionChange} onClick={() => void openPositionApplication()}>岗位变更申请</Button>
        {/* 我的岗位申请记录（base PRD §6：个人中心内可查看本人的岗位申请记录，全员能力，M27） */}
        <Button onClick={() => navigate('/me/position-applications')}>我的岗位申请记录</Button>
        <Button onClick={() => navigate('/me/operation-logs')}>我的操作日志</Button>
      </Space>

      <Drawer title="岗位变更申请" open={positionOpen} onClose={() => { setPositionOpen(false); positionForm.resetFields(); }} width="min(92vw, 420px)">
        <Form form={positionForm} layout="vertical" onFinish={(values) => void submitPositionApplication(values)}>
          <Form.Item name="targetDepartmentId" label="目标部门" rules={[{ required: true, message: '请选择目标部门' }]}><Select showSearch optionFilterProp="label" loading={positionOptionsLoading} options={positionOptions.departments.map((department) => ({ label: department.name, value: department.id }))} onChange={() => positionForm.setFieldValue('targetPositionId', undefined)} /></Form.Item>
          <Form.Item name="targetPositionId" label="目标岗位" rules={[{ required: true, message: '请选择目标岗位' }]}><Select showSearch optionFilterProp="label" loading={positionOptionsLoading} disabled={selectedDepartmentId === undefined} options={positionSelectOptions} /></Form.Item>
          <Button type="primary" htmlType="submit" loading={positionSubmitting}>提交申请</Button>
        </Form>
      </Drawer>
    </Space>
  );
}

/** 我的岗位申请记录（base PRD §6：仅展示本人提交的岗位变更申请；独立页面，M27）。 */
function PositionApplications() {
  const navigate = useNavigate();
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[{ title: '门户', href: '/portal' }, { title: '个人中心', href: '/me' }, { title: '我的岗位申请记录' }]} />
      <DataTable title="我的岗位申请记录" service="platform" endpoint="/me/position-applications" pageKey="me-position-applications" columns={[{ key: 'applicationNo', title: '申请编号' }, { key: 'targetDepartmentName', title: '目标部门' }, { key: 'targetPositionName', title: '目标岗位' }, { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> }, { key: 'submittedAt', title: '提交时间' }]} actions={<Button onClick={() => navigate('/me')}>返回个人中心</Button>} />
    </Space>
  );
}

/** 我的操作日志（base PRD §6：仅展示当前账号的操作记录；独立页面，M27）。 */
function OperationLogsPage() {
  const navigate = useNavigate();
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[{ title: '门户', href: '/portal' }, { title: '个人中心', href: '/me' }, { title: '我的操作日志' }]} />
      <DataTable title="我的操作日志" service="platform" endpoint="/me/operation-logs" pageKey="me-operation-logs" columns={[{ key: 'createdAt', title: '时间' }, { key: 'system', title: '系统' }, { key: 'feature', title: '功能' }, { key: 'actionType', title: '操作' }, { key: 'summary', title: '摘要' }]} filterFields={[{ key: 'system', title: '系统', type: 'enum', options: [{ label: '基础平台', value: 'BASE' }, { label: '管理后台', value: 'BACKSTAGE' }, { label: '资产系统', value: 'ASSET' }, { label: '人事系统', value: 'HR' }, { label: '财务系统', value: 'FIN' }] }, { key: 'feature', title: '功能', type: 'enum', options: (filters) => catalogFunctionOptions(filters.find((filter) => filter.field === 'system')?.value) }, { key: 'actionType', title: '操作', type: 'enum', options: [{ label: '新增', value: 'CREATE' }, { label: '修改', value: 'UPDATE' }, { label: '删除', value: 'DELETE' }, { label: '导出', value: 'EXPORT' }] }, { key: 'createdAt', title: '时间', type: 'date' }]} exportConfig={{ allEndpoint: '/me/operation-logs/export', filename: 'my-operation-logs.xlsx' }} actions={<Button onClick={() => navigate('/me')}>返回个人中心</Button>} />
    </Space>
  );
}
