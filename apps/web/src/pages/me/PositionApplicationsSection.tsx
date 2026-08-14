import { Button, Card, Form, Modal, Select, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { DataTable, StatusTag } from '../../components/DataTable';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import { useMeData } from './use-me-data';

interface PositionApplicationOptions {
  departments: Array<{ id: number; name: string }>;
  positions: Array<{ id: number; name: string; departmentIds: number[] }>;
}

interface PositionApplicationFormValues {
  targetDepartmentId: number;
  targetPositionId: number;
}

/**
 * 岗位申请（base PRD §6）：上半为申请入口（弹窗内选择目标部门+目标岗位提交），
 * 下半为本人历史记录（分页表格）。仅无部门或单部门员工可自助申请（canApplyPositionChange）。
 */
export function PositionApplicationsSection() {
  const feedback = useFeedback();
  const { me } = useMeData();
  const [applyOpen, setApplyOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [options, setOptions] = useState<PositionApplicationOptions>({ departments: [], positions: [] });
  const [optionsLoading, setOptionsLoading] = useState(false);
  /** 提交成功后重挂载历史表格，触发重新拉数。 */
  const [historyKey, setHistoryKey] = useState(0);
  const [form] = Form.useForm<PositionApplicationFormValues>();

  const selectedDepartmentId = Form.useWatch('targetDepartmentId', form);
  const positionSelectOptions = options.positions
    .filter((position) => selectedDepartmentId === undefined || position.departmentIds.includes(selectedDepartmentId))
    .map((position) => ({ label: position.name, value: position.id }));

  async function openApply() {
    setApplyOpen(true);
    setOptionsLoading(true);
    try {
      const data = await http.get<PositionApplicationOptions>('/self-service/position-application-options', { service: 'hr', active: true });
      setOptions(data);
    } catch (error) {
      feedback.error(error, '岗位申请选项加载失败');
    } finally {
      setOptionsLoading(false);
    }
  }

  function closeApply() {
    setApplyOpen(false);
    form.resetFields();
  }

  async function submit(values: PositionApplicationFormValues) {
    setSubmitting(true);
    try {
      await http.post('/me/position-applications', values);
      feedback.success('岗位申请已提交，等待审批');
      closeApply();
      setHistoryKey((value) => value + 1);
    } catch (error) {
      feedback.error(error, '岗位申请提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  const canApply = me?.canApplyPositionChange === true;

  return (
    <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      <Card title="岗位申请">
        <Typography.Paragraph type="secondary">
          每张申请只能选择一个目标部门和一个目标岗位，审批通过后生效；仅当前无部门或仅属于一个部门的员工可自助申请。
        </Typography.Paragraph>
        <Tooltip title={canApply ? undefined : '已属于多个部门的员工不能自助变更组织关系，请联系管理员调整'}>
          <Button type="primary" disabled={!canApply} onClick={() => void openApply()}>
            发起岗位申请
          </Button>
        </Tooltip>
      </Card>

      <DataTable
        key={historyKey}
        title="历史记录"
        service="platform"
        endpoint="/me/position-applications"
        pageKey="me-position-applications"
        columns={[
          { key: 'applicationNo', title: '申请编号' },
          { key: 'targetDepartmentName', title: '目标部门' },
          { key: 'targetPositionName', title: '目标岗位' },
          { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> },
          { key: 'submittedAt', title: '提交时间' },
        ]}
      />

      <Modal title="岗位变更申请" open={applyOpen} onCancel={closeApply} footer={null} destroyOnHidden width="min(92vw, 420px)">
        <Form form={form} layout="vertical" onFinish={(values) => void submit(values)} preserve={false}>
          <Form.Item name="targetDepartmentId" label="目标部门" rules={[{ required: true, message: '请选择目标部门' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              loading={optionsLoading}
              options={options.departments.map((department) => ({ label: department.name, value: department.id }))}
              onChange={() => form.setFieldValue('targetPositionId', undefined)}
            />
          </Form.Item>
          <Form.Item name="targetPositionId" label="目标岗位" rules={[{ required: true, message: '请选择目标岗位' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              loading={optionsLoading}
              disabled={selectedDepartmentId === undefined}
              options={positionSelectOptions}
            />
          </Form.Item>
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={closeApply}>取消</Button>
            <Button type="primary" htmlType="submit" loading={submitting}>
              提交申请
            </Button>
          </Space>
        </Form>
      </Modal>
    </Space>
  );
}
