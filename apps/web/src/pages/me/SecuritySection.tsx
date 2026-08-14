import { DingtalkOutlined, KeyOutlined, MobileOutlined } from '@ant-design/icons';
import { Button, Card, Divider, Flex, Form, Input, Modal, Space, Tag, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFeedback } from '../../request/feedback';
import { ApiError, http } from '../../request/http';
import { useSession } from '../../request/session';

interface SecurityItem {
  key: string;
  icon: ReactNode;
  title: string;
  description: string;
  /** 行右侧内容：操作按钮或只读状态。 */
  extra: ReactNode;
}

interface PasswordFormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const PASSWORD_LENGTH_RULE = { min: 8, max: 32, message: '密码需 8~32 个字符' };

/**
 * 账户安全（base PRD §2/§6）：高安全风险能力的统一入口，条目行式布局（参考主流产品账号安全页）。
 * 修改密码在弹窗内完成（成功后全部会话失效）；手机号以钉钉授权自动同步为准，平台不提供修改入口，
 * 仅展示脱敏号码与同步规则说明（本期不接短信验证，无换绑功能）。
 */
export function SecuritySection() {
  const feedback = useFeedback();
  const navigate = useNavigate();
  const { user, hasDingtalkBinding } = useSession();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<PasswordFormValues>();

  async function changePassword(values: PasswordFormValues) {
    setSubmitting(true);
    try {
      await http.post('/auth/password/change', values);
      feedback.success('密码已修改，请重新登录');
      setPasswordOpen(false);
      navigate('/login', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        feedback.error(error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const items: SecurityItem[] = [
    {
      key: 'password',
      icon: <KeyOutlined />,
      title: '登录密码',
      description: '定期修改密码可提升账号安全性；修改成功后全部登录状态失效，需重新登录。',
      extra: <Button onClick={() => setPasswordOpen(true)}>修改密码</Button>,
    },
    {
      key: 'phone',
      icon: <MobileOutlined />,
      title: '手机号',
      description: '手机号以钉钉授权返回的号码为准，平台内不提供修改入口；钉钉侧更换号码后，下次钉钉扫码登录时将自动同步更新。',
      extra: <Typography.Text strong>{user?.phoneMasked ?? '—'}</Typography.Text>,
    },
    {
      key: 'dingtalk',
      icon: <DingtalkOutlined />,
      title: '钉钉账号',
      description: hasDingtalkBinding
        ? '可使用钉钉扫码登录，手机号随每次钉钉授权自动同步。'
        : '未绑定钉钉账号，无法使用扫码登录与手机号自动同步，请联系管理员处理。',
      extra: hasDingtalkBinding ? <Tag color="success">已绑定</Tag> : <Tag>未绑定</Tag>,
    },
  ];

  return (
    <Card title="账户安全">
      {items.map((item, index) => (
        <div key={item.key}>
          {index > 0 ? <Divider style={{ margin: 0 }} /> : null}
          <Flex align="center" justify="space-between" gap={16} style={{ paddingTop: index === 0 ? 0 : 16, paddingBottom: index === items.length - 1 ? 0 : 16 }}>
            <Flex gap={12}>
              <Typography.Text type="secondary" style={{ fontSize: 18 }}>
                {item.icon}
              </Typography.Text>
              <Flex vertical gap={4}>
                <Typography.Text strong>{item.title}</Typography.Text>
                <Typography.Text type="secondary">{item.description}</Typography.Text>
              </Flex>
            </Flex>
            {item.extra}
          </Flex>
        </div>
      ))}

      <Modal title="修改密码" open={passwordOpen} onCancel={() => setPasswordOpen(false)} footer={null} destroyOnHidden width="min(92vw, 420px)">
        <Form form={form} layout="vertical" onFinish={(values) => void changePassword(values)} requiredMark={false} preserve={false}>
          <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }, PASSWORD_LENGTH_RULE]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator: (_, value: string) =>
                  value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
            修改成功后全部登录状态失效，需重新登录。
          </Typography.Paragraph>
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setPasswordOpen(false)}>取消</Button>
            <Button type="primary" htmlType="submit" loading={submitting}>
              保存
            </Button>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
