import { Alert, Button, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';

interface DingtalkImportCandidate {
  unionId: string;
  name: string;
  phone: string;
  importable: boolean;
  disabledReason?: string;
}

interface CandidateResponse {
  snapshotId: string;
  data: DingtalkImportCandidate[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

interface DingtalkImportModalProps {
  open: boolean;
  onCancel: () => void;
  onImported: () => void;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * 钉钉员工导入弹窗。
 *
 * 姓名和手机号仅用于展示与搜索，提交时只发送 unionId 和服务端快照标识；禁选规则由
 * 服务端计算，确认导入时还会再次校验，避免前端状态过期或被篡改后错误创建账号。
 */
export function DingtalkImportModal({ open, onCancel, onImported }: DingtalkImportModalProps) {
  const feedback = useFeedback();
  const [rows, setRows] = useState<DingtalkImportCandidate[]>([]);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [selectedUnionIds, setSelectedUnionIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async (options: { page: number; keyword: string; snapshotId?: string | null; refresh?: boolean }) => {
    const nextPage = options.page;
    const nextKeyword = options.keyword;
    const query = new URLSearchParams({ page: String(nextPage), pageSize: String(DEFAULT_PAGE_SIZE) });
    if (nextKeyword.trim()) query.set('keyword', nextKeyword.trim());
    if (options.refresh) query.set('refresh', 'true');
    else if (options.snapshotId) query.set('snapshotId', options.snapshotId);
    setLoading(true);
    try {
      const result = await http.get<CandidateResponse>(`/users/dingtalk-import/candidates?${query.toString()}`, { active: true });
      setRows(result.data);
      setSnapshotId(result.snapshotId);
      setPage(result.pagination.page);
      setTotal(result.pagination.totalItems);
      if (options.refresh) {
        setSelectedUnionIds([]);
      }
    } catch (error) {
      feedback.error(error, '钉钉员工列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [feedback]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setPage(1);
    setKeyword('');
    setSelectedUnionIds([]);
    setSnapshotId(null);
    void load({ page: 1, keyword: '', refresh: true });
  }, [load, open]);

  const selectedCount = selectedUnionIds.length;
  const selectedRowKeys = useMemo(() => selectedUnionIds, [selectedUnionIds]);

  const search = (value: string) => {
    setKeyword(value);
    void load({ page: 1, keyword: value, snapshotId });
  };

  const refresh = () => {
    void load({ page: 1, keyword, refresh: true });
  };

  const confirmImport = async () => {
    if (!snapshotId || selectedUnionIds.length === 0) {
      feedback.info('请先选择至少一名可导入员工');
      return;
    }
    const confirmed = await feedback.confirm({
      title: `确认导入 ${selectedUnionIds.length} 名钉钉员工？`,
      content: '导入后会立即创建可用账号、写入默认密码并自动绑定钉钉账号，员工可直接扫码登录。',
      okText: '确认导入',
    });
    if (!confirmed) {
      return;
    }
    setImporting(true);
    try {
      const result = await http.post<{ importedCount: number }>('/users/dingtalk-import', {
        snapshotId,
        unionIds: selectedUnionIds,
      });
      feedback.success(`已成功导入 ${result.importedCount} 名员工`);
      onImported();
      onCancel();
    } catch (error) {
      feedback.error(error, '导入员工失败，请刷新后重试');
      void load({ page: 1, keyword, refresh: true });
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      title="从钉钉导入员工"
      open={open}
      onCancel={onCancel}
      width="min(96vw, 1180px)"
      destroyOnHidden
      footer={(
        <Space>
          <Typography.Text type="secondary">已选择 {selectedCount} 名</Typography.Text>
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" loading={importing} disabled={selectedCount === 0 || !snapshotId} onClick={() => void confirmImport()}>
            确认导入
          </Button>
        </Space>
      )}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="仅显示当前钉钉应用获授通讯录范围内的员工"
          description="手机号已被平台账号使用、钉钉 ID 已绑定、已离职或资料不完整的员工不可选择。"
        />
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Input.Search
            aria-label="搜索钉钉员工"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onSearch={search}
            allowClear
            placeholder="搜索姓名或手机号"
            enterButton={<SearchOutlined />}
            style={{ width: 'min(100%, 360px)' }}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>刷新钉钉员工</Button>
        </Space>
        <Table<DingtalkImportCandidate>
          rowKey="unionId"
          dataSource={rows}
          loading={loading}
          size="middle"
          scroll={{ x: 760, y: 'calc(72vh - 300px)' }}
          rowSelection={{
            preserveSelectedRowKeys: true,
            selectedRowKeys,
            onChange: (keys) => setSelectedUnionIds(keys.map(String)),
            getCheckboxProps: (record) => ({ disabled: !record.importable }),
          }}
          columns={[
            { title: '姓名', dataIndex: 'name', key: 'name', width: 220 },
            { title: '手机号', dataIndex: 'phone', key: 'phone', width: 220 },
            {
              title: '导入状态',
              key: 'status',
              width: 260,
              render: (_value, record) => record.importable
                ? <Tag color="success">可导入</Tag>
                : <Typography.Text type="secondary">{record.disabledReason ?? '不可导入'}</Typography.Text>,
            },
          ]}
          pagination={{
            current: page,
            pageSize: DEFAULT_PAGE_SIZE,
            total,
            showSizeChanger: false,
            showTotal: (count) => `共 ${count} 名员工`,
            onChange: (nextPage) => void load({ page: nextPage, keyword, snapshotId }),
          }}
        />
      </Space>
    </Modal>
  );
}
