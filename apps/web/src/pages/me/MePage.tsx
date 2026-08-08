import { App as AntApp, Button, Card, Descriptions, Divider, Form, Input, Radio, Space, Typography } from 'antd';
import { ArrowLeftOutlined, KeyOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, http, newIdempotencyKey } from '../../request/http';

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
 * 修改密码（成功后全部会话失效）；岗位申请与我的操作日志为契约预留（T6-6/T4-1）。
 */
export default function MePage() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [me, setMe] = useState<MeData | null>(null);
  const [profileForm] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);

  useEffect(() => {
    void http
      .get<MeData>('/me', { active: true })
      .then((data) => {
        setMe(data);
        profileForm.setFieldsValue({ name: data.user.name, gender: data.user.gender });
      })
      .catch((error) => {
        if (error instanceof ApiError) {
          message.error(error.body.message);
        }
      });
  }, [message, profileForm]);

  async function submitProfile(values: { name: string; gender: 'MALE' | 'FEMALE' }) {
    setProfileSubmitting(true);
    try {
      const result = await http.put<{ applied: boolean; requestId?: number }>('/me/profile', values, {
        idempotencyKey: newIdempotencyKey(),
      });
      if (result.applied) {
        message.success('资料已更新');
      } else {
        message.success('资料修改申请已提交，等待管理员审批');
      }
      setMe((prev) => (prev ? { ...prev, pendingProfileChange: !result.applied || prev.pendingProfileChange } : prev));
    } catch (error) {
      if (error instanceof ApiError) {
        message.error(error.body.message);
      }
    } finally {
      setProfileSubmitting(false);
    }
  }

  async function changePassword(values: { currentPassword: string; newPassword: string; confirmPassword: string }) {
    if (values.newPassword !== values.confirmPassword) {
      message.error('两次输入的密码不一致');
      return;
    }
    setPasswordSubmitting(true);
    try {
      await http.post(
        '/auth/password/change',
        { currentPassword: values.currentPassword, newPassword: values.newPassword, confirmPassword: values.confirmPassword },
        { idempotencyKey: newIdempotencyKey() },
      );
      message.success('密码已修改，请重新登录');
      navigate('/login', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        message.error(error.body.message);
      }
    } finally {
      setPasswordSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/portal')}>
            返回门户
          </Button>
          <Typography.Title level={3} style={{ marginTop: 16, marginBottom: 4 }}>
            个人中心
          </Typography.Title>
        </div>

        <Card title="身份信息">
          <Descriptions column={2} size="small">
            <Descriptions.Item label="姓名">{me?.user.name}</Descriptions.Item>
            <Descriptions.Item label="性别">{me?.user.gender === 'MALE' ? '男' : '女'}</Descriptions.Item>
            <Descriptions.Item label="手机号">{me?.user.phoneMasked}</Descriptions.Item>
            <Descriptions.Item label="账号状态">{me?.user.status === 'ACTIVE' ? '正常' : me?.user.status}</Descriptions.Item>
            <Descriptions.Item label="部门">-（组织信息由人事系统提供）</Descriptions.Item>
            <Descriptions.Item label="岗位">-（组织信息由人事系统提供）</Descriptions.Item>
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
          <Button disabled title="岗位申请功能由人事系统提供（即将开放）">岗位变更申请（即将开放）</Button>
          <Button disabled title="我的操作日志功能即将开放">我的操作日志（即将开放）</Button>
        </Space>
      </Space>
    </div>
  );
}
