import { Button, Card, Descriptions, Form, Input, Modal, Radio, Space, Typography } from 'antd';
import { useState } from 'react';
import { formatBeijingDateTime } from '../../components/display-format';
import { useFeedback } from '../../request/feedback';
import { ApiError, http } from '../../request/http';
import { useMeData } from './use-me-data';

interface ProfileFormValues {
  name: string;
  gender: 'MALE' | 'FEMALE';
}

/**
 * 个人资料（base PRD §6）：默认只读展示；修改必须点击「修改资料」在弹窗中编辑并保存/取消。
 * 可改字段只有姓名与性别（超管直改、员工走审批）；手机号以钉钉授权为准，不提供编辑入口。
 */
export function ProfileSection() {
  const feedback = useFeedback();
  const { me, reload } = useMeData();
  const [editOpen, setEditOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<ProfileFormValues>();
  const watchedName = Form.useWatch('name', form);
  const watchedGender = Form.useWatch('gender', form);
  const noChange = Boolean(me && watchedName === me.user.name && watchedGender === me.user.gender);

  function openEdit() {
    setEditOpen(true);
  }

  async function submit(values: ProfileFormValues) {
    if (me && values.name === me.user.name && values.gender === me.user.gender) {
      feedback.info('没有需要保存的修改');
      setEditOpen(false);
      return;
    }
    setSubmitting(true);
    try {
      const result = await http.put<{ applied: boolean; requestId?: number }>('/me/profile', values);
      feedback.success(result.applied ? '资料已更新' : '资料修改申请已提交，等待管理员审批');
      setEditOpen(false);
      reload();
    } catch (error) {
      if (error instanceof ApiError) {
        feedback.error(error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const departmentNames = me?.departments.map((department) => department.name).join('、') || '—';
  const positionNames = me?.positions.map((position) => position.name).join('、') || '—';

  return (
    <Card
      title="个人资料"
      loading={!me}
      extra={
        <Space size="middle">
          {me?.pendingProfileChange ? <Typography.Text type="warning">已有待审批的资料修改申请</Typography.Text> : null}
          <Button type="primary" disabled={!me || me.pendingProfileChange} onClick={openEdit}>
            修改资料
          </Button>
        </Space>
      }
    >
      <Descriptions column={{ xs: 1, sm: 2 }} size="small">
        <Descriptions.Item label="姓名">{me?.user.name}</Descriptions.Item>
        <Descriptions.Item label="性别">{me?.user.gender === 'MALE' ? '男' : '女'}</Descriptions.Item>
        <Descriptions.Item label="手机号">{me?.user.phoneMasked}</Descriptions.Item>
        <Descriptions.Item label="账号状态">{me?.user.status === 'ACTIVE' ? '正常' : me?.user.status}</Descriptions.Item>
        <Descriptions.Item label="部门">{departmentNames}</Descriptions.Item>
        <Descriptions.Item label="岗位">{positionNames}</Descriptions.Item>
        <Descriptions.Item label="注册时间">{me ? formatBeijingDateTime(me.user.createdAt) : '—'}</Descriptions.Item>
      </Descriptions>

      <Modal title="修改资料" open={editOpen} onCancel={() => setEditOpen(false)} footer={null} destroyOnHidden width="min(92vw, 420px)">
        {/* 弹窗内容随 destroyOnHidden 每次打开重新挂载，initialValues 即当前资料，实现打开回填 */}
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void submit(values)}
          requiredMark={false}
          preserve={false}
          initialValues={{ name: me?.user.name, gender: me?.user.gender }}
        >
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }, { max: 50, message: '姓名最长 50 个字符' }]}>
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="gender" label="性别" rules={[{ required: true, message: '请选择性别' }]}>
            <Radio.Group>
              <Radio value="MALE">男</Radio>
              <Radio value="FEMALE">女</Radio>
            </Radio.Group>
          </Form.Item>
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setEditOpen(false)}>取消</Button>
            <Button type="primary" htmlType="submit" loading={submitting} disabled={noChange}>
              保存
            </Button>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
