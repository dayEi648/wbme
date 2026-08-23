import { Button, Card, Form, Input, Space, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, http } from '../../request/http';
import { useFeedback } from '../../request/feedback';

/**
 * 密码重置（base PRD §2）：
 * 入口页读取 fragment 凭证兑换（发重置流程 Cookie）→ 钉钉授权（RESET）→ 完成页设新密码。
 */
export default function ResetPasswordPage() {
  const feedback = useFeedback();
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<'redeeming' | 'failed'>('redeeming');
  const [errorMessage, setErrorMessage] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    const token = location.hash.replace(/^#/, '');
    if (!token) {
      setState('failed');
      setErrorMessage('重置链接缺少凭证，请联系管理员重新生成');
      return;
    }
    void (async () => {
      try {
        await http.post('/auth/password/reset/redeem', { token });
        window.history.replaceState(null, '', '/reset-password');
        const { authorizeUrl } = await http.get<{ authorizeUrl: string }>('/auth/dingtalk/authorize?purpose=RESET');
        window.location.href = authorizeUrl;
      } catch (error) {
        // 兑换失败同样清除地址栏 fragment（凭证已失效，不滞留地址栏/截图/历史）
        window.history.replaceState(null, '', '/reset-password');
        setState('failed');
        setErrorMessage(error instanceof ApiError ? error.body.message : '兑换失败');
        feedback.error(error, error instanceof ApiError ? error.body.message : '兑换失败');
      }
    })();
  }, [location.hash, feedback]);

  if (state === 'redeeming') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="正在校验重置凭证..." />
      </div>
    );
  }
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card style={{ width: 'min(420px, 100vw - 32px)' }}>
        <Typography.Paragraph style={{ textAlign: 'center' }}>{errorMessage}</Typography.Paragraph>
        <Button type="primary" block onClick={() => navigate('/login')}>
          返回登录
        </Button>
      </Card>
    </div>
  );
}

/** 重置完成页（钉钉授权回调后）：设置新密码（完成后全会话失效，重新登录） */
export function ResetCompletePage() {
  const feedback = useFeedback();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);

  async function onFinish(values: { newPassword: string; confirmPassword: string }) {
    if (values.newPassword !== values.confirmPassword) {
      feedback.error(new Error('两次输入的密码不一致'), '两次输入的密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await http.post('/auth/password/reset/confirm', {
        newPassword: values.newPassword,
        confirmPassword: values.confirmPassword,
      });
      feedback.success('密码已重置，请重新登录');
      navigate('/login', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        feedback.error(error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card style={{ width: 'min(420px, 100vw - 32px)' }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
            <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 8, max: 32, message: '密码需 8~32 个字符' }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item name="confirmPassword" label="确认新密码" rules={[{ required: true, min: 8, max: 32 }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" block loading={submitting}>
                确认重置
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </div>
  );
}
