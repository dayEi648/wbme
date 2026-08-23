import { Button, Card, Form, Input, Radio, Space } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, http } from '../../request/http';
import { useFeedback } from '../../request/feedback';
import { useSession } from '../../request/session';

interface ActivatePayload {
  name: string;
  gender: 'MALE' | 'FEMALE';
  password: string;
  confirmPassword: string;
}

/**
 * 激活完成页（base PRD §2）：钉钉授权回调后确认姓名/性别/密码，
 * 提交后单事务完成激活并自动登录进入门户。
 */
export default function ActivateCompletePage() {
  const feedback = useFeedback();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [submitting, setSubmitting] = useState(false);

  async function onFinish(values: ActivatePayload) {
    if (values.password !== values.confirmPassword) {
      feedback.error(new Error('两次输入的密码不一致'), '两次输入的密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await http.post('/auth/activation/confirm', {
        name: values.name,
        gender: values.gender,
        password: values.password,
        confirmPassword: values.confirmPassword,
      });
      await refresh();
      feedback.success('账号已激活，欢迎使用');
      navigate('/portal', { replace: true });
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
          <Form<ActivatePayload> layout="vertical" onFinish={onFinish} requiredMark={false} initialValues={{ gender: 'MALE' }}>
            <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }, { max: 50 }]}>
              <Input placeholder="姓名" maxLength={50} />
            </Form.Item>
            <Form.Item name="gender" label="性别" rules={[{ required: true }]}>
              <Radio.Group>
                <Radio value="MALE">男</Radio>
                <Radio value="FEMALE">女</Radio>
              </Radio.Group>
            </Form.Item>
            <Form.Item name="password" label="平台密码" rules={[{ required: true, min: 8, max: 32, message: '密码需 8~32 个字符' }]}>
              <Input.Password placeholder="8~32 个字符" />
            </Form.Item>
            <Form.Item name="confirmPassword" label="确认密码" rules={[{ required: true, min: 8, max: 32 }]}>
              <Input.Password placeholder="再次输入密码" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" block loading={submitting}>
                完成激活
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </div>
  );
}
