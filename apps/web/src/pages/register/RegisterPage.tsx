import { App as AntApp, Button, Card, Form, Input, Radio, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, http } from '../../request/http';
import { useSession } from '../../request/session';

interface RegisterPayload {
  name: string;
  gender: 'MALE' | 'FEMALE';
  password: string;
  confirmPassword: string;
}

/**
 * 扫码注册完善页（base PRD §2）：手机号取自钉钉授权结果只读展示，
 * 填写/确认姓名、性别并设置平台密码，确认后创建账号并自动登录。
 */
export default function RegisterPage() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void http
      .get<{ phone: string }>('/auth/registration/context')
      .then((res) => setPhone(res.phone))
      .catch((error) => {
        // 注册流程会话失效：明确提示（base PRD §3 不产生无提示跳转）
        setPhone('');
        message.error(error instanceof ApiError ? error.body.message : '注册会话已失效，请重新扫码注册');
      });
  }, [message]);

  async function onFinish(values: RegisterPayload) {
    if (values.password !== values.confirmPassword) {
      message.error('两次输入的密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await http.post('/auth/registration/confirm', {
        name: values.name,
        gender: values.gender,
        password: values.password,
        confirmPassword: values.confirmPassword,
      });
      await refresh();
      message.success('注册成功');
      navigate('/portal', { replace: true });
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
              完善注册信息
            </Typography.Title>
            <Typography.Text type="secondary">
              手机号 <Typography.Text strong>{phone}</Typography.Text>（来自钉钉，只读）
            </Typography.Text>
          </div>
          <Form<RegisterPayload> layout="vertical" onFinish={onFinish} requiredMark={false} initialValues={{ gender: 'MALE' }}>
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
                确认注册
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </div>
  );
}
