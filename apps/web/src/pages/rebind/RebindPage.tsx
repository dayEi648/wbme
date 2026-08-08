import { App as AntApp, Button, Card, Form, Input, Space, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, http, newIdempotencyKey } from '../../request/http';
import { useSession } from '../../request/session';

/**
 * 钉钉换绑（base PRD §2、backstage PRD §3）：
 * - 自助换绑：个人中心入口（验证平台密码）→ 钉钉授权（REBIND）→ 完成确认；
 * - 管理员代发：/rebind#<token> 兑换 → 钉钉授权 → 完成确认；
 * - 换绑成功后全部会话失效。
 */
export default function RebindPage() {
  const { message } = AntApp.useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<'idle' | 'redeeming' | 'failed'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const started = useRef(false);

  // 支持超管代发链接：/rebind#<token> → 兑换
  useEffect(() => {
    const token = location.hash.replace(/^#/, '');
    if (!token || started.current) {
      return;
    }
    started.current = true;
    setState('redeeming');
    void (async () => {
      try {
        await http.post('/auth/rebind/redeem', { token });
        window.history.replaceState(null, '', '/rebind');
        const { authorizeUrl } = await http.get<{ authorizeUrl: string }>('/auth/dingtalk/authorize?purpose=REBIND');
        window.location.href = authorizeUrl;
      } catch (error) {
        setState('failed');
        setErrorMessage(error instanceof ApiError ? error.body.message : '兑换失败');
      }
    })();
  }, [location.hash, message]);

  /** 自助换绑：验证平台密码后发起钉钉授权 */
  async function startSelfRebind(values: { password: string }) {
    setSubmitting(true);
    try {
      const { authorizeUrl } = await http.post<{ authorizeUrl: string }>('/auth/rebind/self-initiate', values, {
        idempotencyKey: newIdempotencyKey(),
      });
      window.location.href = authorizeUrl;
    } catch (error) {
      if (error instanceof ApiError) {
        message.error(error.body.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (state === 'redeeming') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="正在校验换绑凭证..." />
      </div>
    );
  }
  if (state === 'failed') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Card style={{ width: 420 }}>
          <Typography.Paragraph style={{ textAlign: 'center' }}>{errorMessage}</Typography.Paragraph>
          <Button type="primary" block onClick={() => navigate(user ? '/me' : '/login')}>
            返回
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card style={{ width: 420 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Typography.Title level={4} style={{ marginBottom: 4 }}>
              钉钉身份换绑
            </Typography.Title>
            <Typography.Text type="secondary">
              验证平台密码后扫码授权新钉钉身份；换绑成功后全部会话失效，需重新登录
            </Typography.Text>
          </div>
          {user ? (
            <Form layout="vertical" onFinish={startSelfRebind} requiredMark={false}>
              <Form.Item name="password" label="平台密码" rules={[{ required: true, message: '请输入平台密码' }]}>
                <Input.Password placeholder="验证当前账号" autoComplete="current-password" />
              </Form.Item>
              <Form.Item style={{ marginBottom: 0 }}>
                <Button type="primary" htmlType="submit" block loading={submitting}>
                  开始换绑
                </Button>
              </Form.Item>
            </Form>
          ) : (
            <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
              请先登录后从个人中心发起自助换绑，或使用管理员提供的换绑链接
            </Typography.Paragraph>
          )}
          <Button block onClick={() => navigate(user ? '/me' : '/login')}>
            返回
          </Button>
        </Space>
      </Card>
    </div>
  );
}

/** 换绑完成页（钉钉授权回调后）：确认提交（原子替换绑定） */
export function RebindCompletePage() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);

  async function confirmRebind() {
    setSubmitting(true);
    try {
      await http.post('/auth/rebind/confirm', {}, { idempotencyKey: newIdempotencyKey() });
      message.success('换绑成功，请重新登录');
      navigate('/login', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        message.error(error.body.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card style={{ width: 420 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Typography.Title level={4} style={{ marginBottom: 4 }}>
              确认换绑
            </Typography.Title>
            <Typography.Text type="secondary">将当前账号的钉钉身份替换为新授权的身份</Typography.Text>
          </div>
          <Button type="primary" block loading={submitting} onClick={confirmRebind}>
            确认换绑
          </Button>
          <Button block onClick={() => navigate('/me')}>
            取消
          </Button>
        </Space>
      </Card>
    </div>
  );
}
