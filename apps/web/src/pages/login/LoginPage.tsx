import { App as AntApp, Button, Card, Checkbox, Form, Input, Space, Typography } from 'antd';
import { QrcodeOutlined, UserOutlined, LockOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, http, newIdempotencyKey } from '../../request/http';
import { useSession } from '../../request/session';

interface LoginPayload {
  phone: string;
  password: string;
  rememberMe?: boolean;
}

/** 登录页（base PRD §2）：手机号 + 密码 与 钉钉扫码双通道 */
export default function LoginPage() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [submitting, setSubmitting] = useState(false);

  async function onFinish(values: LoginPayload) {
    setSubmitting(true);
    try {
      await http.post('/auth/login/password', values, { idempotencyKey: newIdempotencyKey() });
      await refresh();
      message.success('登录成功');
      navigate('/portal', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        message.error(error.body.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** 钉钉扫码入口：服务端签发一次性 state 后跳转钉钉授权页 */
  async function startDingtalkLogin() {
    try {
      const { authorizeUrl } = await http.get<{ authorizeUrl: string }>('/auth/dingtalk/authorize?purpose=LOGIN');
      window.location.href = authorizeUrl;
    } catch (error) {
      if (error instanceof ApiError) {
        message.error(error.body.message);
      }
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--wbme-bg)' }}>
      <Card style={{ width: 380 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              WBME 企业管理平台
            </Typography.Title>
            <Typography.Text type="secondary">统一登录入口</Typography.Text>
          </div>
          <Form<LoginPayload> layout="vertical" onFinish={onFinish} requiredMark={false}>
            <Form.Item name="phone" label="手机号" rules={[{ required: true, message: '请输入手机号' }]}>
              <Input prefix={<UserOutlined />} placeholder="手机号" maxLength={32} autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码（8~32 位）" autoComplete="current-password" />
            </Form.Item>
            <Form.Item name="rememberMe" valuePropName="checked" style={{ marginBottom: 12 }}>
              <Checkbox>记住我（延长会话时限）</Checkbox>
            </Form.Item>
            <Form.Item style={{ marginBottom: 12 }}>
              <Button type="primary" htmlType="submit" block loading={submitting}>
                登录
              </Button>
            </Form.Item>
          </Form>
          <Button block icon={<QrcodeOutlined />} onClick={startDingtalkLogin}>
            钉钉扫码登录
          </Button>
        </Space>
      </Card>
    </div>
  );
}
