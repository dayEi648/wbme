import { Button, Card, Checkbox, Form, Input, Modal, Space, Typography } from 'antd';
import { QrcodeOutlined, UserOutlined, LockOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, http } from '../../request/http';
import { useFeedback } from '../../request/feedback';
import { useSession } from '../../request/session';

interface LoginPayload {
  phone: string;
  password: string;
  rememberMe?: boolean;
}

/** 钉钉回调失败跳回登录页的 error 码 → 提示文案（与服务端错误目录一致，base PRD §2） */
const DINGTALK_ERROR_TEXT: Record<string, string> = {
  DINGTALK_ORG_MISMATCH: '当前钉钉账号不属于本公司组织',
  DINGTALK_STATE_INVALID: '授权请求已过期，请重新扫码登录',
  DINGTALK_ALREADY_BOUND: '该钉钉账号已绑定其他平台账号，请走账号恢复流程',
  DINGTALK_CONFIG_MISSING: '钉钉登录暂未配置，请使用手机号登录',
  DEPENDENCY_UNAVAILABLE: '钉钉服务暂不可用，请稍后重试',
  PENDING_ACCOUNT_EXISTS: '已有待激活账号，请联系管理员获取激活邀请',
  PHONE_TAKEN: '该手机号已被使用，请联系管理员处理',
  ACCOUNT_DEACTIVATED: '账号已注销，请联系管理员恢复',
  FLOW_SESSION_INVALID: '操作已过期，请重新开始',
};

/** 登录页（base PRD §2）：手机号 + 密码 与 钉钉扫码双通道；忘记密码（钉钉验证式自助重置）入口 */
export default function LoginPage() {
  const feedback = useFeedback();
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  // 钉钉回调失败跳回 /login?error={code}：展示统一提示并清理 URL（不重复提示）
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get('error');
    if (code) {
      feedback.error(new Error(DINGTALK_ERROR_TEXT[code] ?? '操作失败，请重试'), DINGTALK_ERROR_TEXT[code] ?? '操作失败，请重试');
      window.history.replaceState(null, '', '/login');
    }
  }, [location.search, feedback]);

  async function onFinish(values: LoginPayload) {
    setSubmitting(true);
    try {
      await http.post('/auth/login/password', values);
      await refresh();
      feedback.success('登录成功');
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/portal', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        feedback.error(error);
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
        feedback.error(error);
      }
    }
  }

  /** 忘记密码：已绑定钉钉账号凭手机号发起钉钉验证式重置（base PRD §2） */
  async function startSelfReset(values: { phone: string }) {
    setResetSubmitting(true);
    try {
      const { authorizeUrl } = await http.post<{ authorizeUrl: string }>('/auth/password/reset/initiate', values);
      setResetOpen(false);
      window.location.href = authorizeUrl;
    } catch (error) {
      if (error instanceof ApiError) {
        feedback.error(error);
      }
    } finally {
      setResetSubmitting(false);
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
            <Form.Item style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Form.Item name="rememberMe" valuePropName="checked" noStyle>
                  <Checkbox>记住我（延长会话时限）</Checkbox>
                </Form.Item>
                <Button type="link" size="small" onClick={() => setResetOpen(true)}>
                  忘记密码？
                </Button>
              </div>
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

      <Modal title="重置密码" open={resetOpen} onCancel={() => setResetOpen(false)} footer={null} width={380}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            已绑定钉钉的账号可输入手机号，完成钉钉验证后重新设置密码
          </Typography.Paragraph>
          <Form layout="vertical" onFinish={startSelfReset} requiredMark={false}>
            <Form.Item name="phone" label="手机号" rules={[{ required: true, message: '请输入手机号' }]}>
              <Input placeholder="手机号" maxLength={32} autoComplete="username" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" block loading={resetSubmitting}>
                下一步
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </div>
  );
}
