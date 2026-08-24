import { Alert, Button, Card, Checkbox, Col, Descriptions, Drawer, Form, Input, InputNumber, Popconfirm, Row, Select, Space, Spin, Switch, Table, Tabs, Tag, Typography, type FormInstance } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppShell, type NavigationItem } from '../../components/AppShell';
import { ConfirmAction } from '../../components/ConfirmAction';
import { ApprovalCenter } from '../../components/ApprovalCenter';
import { DataTable, StatusTag } from '../../components/DataTable';
import { ResourceFormModal } from '../../components/ResourceFormModal';
import { SystemHome } from '../../components/SystemHome';
import { SystemSettingsPage, type SystemSettingItem, type SystemSettingPresentation, type SystemSettingsGroup } from '../../components/SystemSettingsPage';
import { MenuManagementTab } from '../../menu-config/MenuManagementTab';
import { useSystemMenuConfig } from '../../menu-config/useSystemMenuConfig';
import { deactivatedUsersSource, permissionEmployeesSource, permissionGroupsSource, PermissionGrantDrawer, type GrantItem, type RemoteOptionSource } from '../../components/selectors';
import { EllipsisLines } from '../../components/EllipsisLines';
import { displayLabel, formatBeijingDateTime, formatDetailValue, formatMoney } from '../../components/display-format';
import { formatEnumLabel } from '../../components/enum-display';
import { catalogFunctionOptions } from '../../permission/catalog';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import { useSession } from '../../request/session';
import { DingtalkImportModal } from './DingtalkImportModal';

type RecordValue = Record<string, unknown>;

const NAVIGATION: NavigationItem[] = [
  { key: 'approval', label: '审批中心', path: '/backstage/approval', permission: 'user_manage' },
  { key: 'users', label: '用户管理', path: '/backstage/users', permission: 'user_manage', group: '用户与权限' },
  { key: 'permissions', label: '人员权限', path: '/backstage/permissions', permission: 'permission_manage', group: '用户与权限' },
  { key: 'groups', label: '权限组', path: '/backstage/permission-groups', permission: 'permission_manage', group: '用户与权限' },
  { key: 'settings', label: '系统设置', path: '/backstage/settings', permission: 'system_settings', group: '内容与配置' },
  { key: 'announcements', label: '系统公告', path: '/backstage/announcements', permission: 'announcement_manage', group: '内容与配置' },
  { key: 'operations', label: '操作日志', path: '/backstage/operation-logs', permission: 'operation_log_view', group: '运维监控' },
  { key: 'system-logs', label: '系统日志', path: '/backstage/system-logs', permission: 'system_log_view', group: '运维监控' },
  { key: 'backups', label: '数据备份与恢复', path: '/backstage/backups', permission: 'data_backup', group: '运维监控' },
  { key: 'health', label: '健康状态', path: '/backstage/health', permission: 'health_status', group: '运维监控' },
  { key: 'release-logs', label: '更新日志', path: '/backstage/release-logs', permission: 'release_log_view', group: '运维监控' },
];

/** 用户管理列表列（/users 载荷：无部门/授权字段；状态枚举中文化）。 */
const USER_COLUMNS = [
  { key: 'name', title: '姓名', sortable: true },
  { key: 'phone', title: '手机号' },
  { key: 'status', title: '状态', enumKind: 'userStatus' as const, sortable: true },
  { key: 'isSuperAdmin', title: '超级管理员', render: (value: unknown) => (value === true ? '是' : '否') },
  { key: 'createdAt', title: '创建时间', sortable: true },
];

const LIST_COLUMNS = [
  { key: 'name', title: '名称' },
  { key: 'status', title: '状态', enumKind: 'dictionaryStatus' as const, render: (value: unknown) => <StatusTag value={value} enumKind="dictionaryStatus" /> },
  { key: 'createdAt', title: '创建时间' },
  { key: 'updatedAt', title: '更新时间' },
];

const OPERATION_SYSTEM_OPTIONS = [
  { label: '基础平台', value: 'BASE' },
  { label: '管理后台', value: 'BACKSTAGE' },
  { label: '资产系统', value: 'ASSET' },
  { label: '人事系统', value: 'HR' },
  { label: '财务系统', value: 'FIN' },
];

/** 操作日志「部门」筛选树（platform-core 按数据范围裁剪后输出扁平 parentId 列表）。 */
const operationLogDepartmentTreeSource: RemoteOptionSource = {
  service: 'platform',
  endpoint: '/operation-logs/department-options',
  tree: true,
};

/**
 * 操作日志「功能」筛选选项：来自权限目录功能清单，
 * 已选「系统」时只列该系统功能（主 PRD §3.3 联动要求）。
 */
function operationFeatureOptions(filters: Array<{ field: string; value: string }>): Array<{ label: string; value: string }> {
  const system = filters.find((filter) => filter.field === 'system')?.value;
  return catalogFunctionOptions(system);
}

const SECURITY_EVENT_TYPE_OPTIONS = [
  { label: '登录成功', value: 'LOGIN_SUCCESS' },
  { label: '登录失败', value: 'LOGIN_FAILURE' },
  { label: '退出登录', value: 'LOGOUT' },
  { label: '账号锁定', value: 'ACCOUNT_LOCK' },
  { label: '账号解锁', value: 'ACCOUNT_UNLOCK' },
  { label: 'IP 锁定', value: 'IP_LOCK' },
  { label: 'IP 解锁', value: 'IP_UNLOCK' },
  { label: '账号激活', value: 'ACCOUNT_ACTIVATED' },
  { label: '签发邀请', value: 'INVITATION_ISSUED' },
  { label: '使用邀请', value: 'INVITATION_USED' },
  { label: '修改密码', value: 'PASSWORD_CHANGED' },
  { label: '签发密码重置', value: 'PASSWORD_RESET_ISSUED' },
  { label: '完成密码重置', value: 'PASSWORD_RESET_COMPLETED' },
  { label: '绑定钉钉', value: 'DINGTALK_BOUND' },
  { label: '同步手机号', value: 'PHONE_SYNCED' },
  { label: '手机号冲突', value: 'PHONE_SYNC_CONFLICT' },
  { label: '内部令牌失败', value: 'INTERNAL_TOKEN_FAILED' },
];

/** 用户详情字段中文名（含解锁状态，解锁显隐见 UserManagement）。 */
const USER_DETAIL_LABELS: Readonly<Record<string, string>> = {
  name: '姓名',
  phone: '手机号',
  gender: '性别',
  status: '状态',
  isSuperAdmin: '超级管理员',
  hasDingtalkBinding: '钉钉绑定',
  createdAt: '创建时间',
  deactivatedAt: '注销时间',
  accountLocked: '登录锁定',
};

/** 恢复预览逐目标字段中文名。 */
const RESTORE_ITEM_LABELS: Readonly<Record<string, string>> = {
  name: '姓名',
  phone: '手机号',
  lifecycleVersion: '生命周期版本',
  restoreStatus: '恢复后状态',
  restorable: '可恢复',
  blockedReason: '阻塞原因',
  revokedGrants: '将撤销的授权',
  removedDepartmentNames: '将清除的部门',
  positionCleared: '岗位置空',
};

/** 错误日志详情字段中文名（嵌套对象常见键同表标签化；未命中键回退通用映射 displayLabel）。 */
const ERROR_LOG_DETAIL_LABELS: Readonly<Record<string, string>> = {
  level: '级别',
  service: '服务',
  source: '来源',
  errorCategory: '错误分类',
  deployCommit: '部署版本',
  fingerprint: '聚合指纹',
  bucketStart: '聚合时段起点',
  firstSeenAt: '首次发生',
  lastSeenAt: '最近发生',
  occurrenceCount: '发生次数',
  firstRequestId: '首次请求 ID',
  lastRequestId: '最近请求 ID',
  sample: '错误样本（已脱敏）',
  status: '处置状态',
  handledAt: '处理时间',
  remark: '处置备注',
  message: '错误消息',
  stack: '调用栈',
};

const ERROR_LOG_COLUMNS = [
  { key: 'level', title: '级别', enumKind: 'logLevel' as const, sortable: true },
  { key: 'service', title: '服务', sortable: true },
  { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} enumKind="errorStatus" />, sortable: true },
  { key: 'occurrenceCount', title: '发生次数', sortable: true },
  { key: 'lastSeenAt', title: '最近发生', sortable: true },
  { key: 'createdAt', title: '首次发生', sortable: true },
];

const SECURITY_LOG_COLUMNS = [
  { key: 'eventType', title: '事件', enumKind: 'securityEventType' as const, sortable: true },
  { key: 'actorName', title: '操作者' },
  { key: 'targetUserName', title: '目标用户' },
  { key: 'result', title: '结果', render: (value: unknown) => <StatusTag value={value} enumKind="securityResult" />, sortable: true },
  { key: 'createdAt', title: '发生时间', sortable: true },
];

const BACKUP_COLUMNS = [
  { key: 'taskType', title: '类型', enumKind: 'backupType' as const },
  { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} enumKind="backupStatus" /> },
  { key: 'backupTime', title: '备份时间' },
  { key: 'finishedAt', title: '完成时间' },
];

const RESTORE_COLUMNS = [
  { key: 'backupId', title: '来源备份' },
  { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} enumKind="restoreStatus" /> },
  { key: 'initiatedAt', title: '发起时间' },
  { key: 'finishedAt', title: '完成时间' },
];

/** 恢复预检结果字段中文名（backupId 已在步骤上下文展示，不重复列出）。 */
const RESTORE_PRECHECK_LABELS: Readonly<Record<string, string>> = {
  backupTime: '备份时间',
  fileSize: '文件大小（字节）',
  checksum: '校验和',
  pgVersion: 'PostgreSQL 版本',
  ready: '预检结果',
};

/** 恢复预检结果展示（枚举式中文标签；未知键回退通用映射）。 */
function restorePrecheckItems(precheck: RecordValue): Array<{ key: string; label: string; children: React.ReactNode }> {
  return Object.entries(precheck)
    .filter(([key]) => key !== 'backupId')
    .map(([key, value]) => {
      let text: unknown = value;
      if (key === 'ready') text = value === true ? '通过' : value === false ? '未通过' : value;
      if (key === 'backupTime' && value) text = formatBeijingDateTime(String(value));
      if (key === 'fileSize' && value !== null && value !== undefined && value !== '') text = formatMoney(String(value));
      return {
        key,
        label: RESTORE_PRECHECK_LABELS[key] ?? displayLabel(key),
        children: <span style={{ whiteSpace: 'pre-wrap' }}>{text === null || text === undefined || text === '' ? '—' : typeof text === 'object' ? JSON.stringify(formatDetailValue(text, RESTORE_PRECHECK_LABELS), null, 2) : String(text)}</span>,
      };
    });
}

/** 错误日志详情展示（枚举式中文标签；状态/级别中文化，时间键转北京时间，未知键回退通用映射）。 */
function errorLogDetailItems(detail: RecordValue): Array<{ key: string; label: string; children: React.ReactNode }> {
  return Object.entries(detail).filter(([key]) => key !== 'id' && key !== 'handledBy').map(([key, value]) => {
    let text: unknown = value;
    if (key === 'status') text = formatEnumLabel('errorStatus', value);
    if (key === 'level') text = formatEnumLabel('logLevel', value);
    if (key === 'bucketStart' || key === 'firstSeenAt' || key === 'lastSeenAt' || key === 'handledAt') text = value ? formatBeijingDateTime(String(value)) : value;
    return {
      key,
      label: ERROR_LOG_DETAIL_LABELS[key] ?? displayLabel(key),
      children: <span style={{ whiteSpace: 'pre-wrap' }}>{text === null || text === undefined || text === '' ? '—' : typeof text === 'object' ? JSON.stringify(formatDetailValue(text, ERROR_LOG_DETAIL_LABELS), null, 2) : String(text)}</span>,
    };
  });
}

/** 管理后台路由容器。 */
export default function BackstagePage() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] ?? '';
  const { items: navigationItems, reload: reloadMenuConfig } = useSystemMenuConfig('BACKSTAGE', NAVIGATION);
  const body = useMemo(() => {
    switch (section) {
      case 'users':
        return <UserManagement />;
      case 'permissions':
        return <PermissionEmployees />;
      case 'approval':
        return <ApprovalCenter title="资料修改审批" service="platform" pageKey="backstage-profile-approval" />;
      case 'permission-groups':
        return <PermissionGroups />;
      case 'settings':
        return <PlatformSettings onMenuSaved={reloadMenuConfig} />;
      case 'operation-logs':
        return <OperationLogs />;
      case 'system-logs':
        return <SystemLogs />;
      case 'announcements':
        return <Announcements />;
      case 'release-logs':
        return <ReleaseLogs />;
      case 'backups':
        return <Backups />;
      case 'health':
        return <HealthStatusPage />;
      default:
        return <SystemHome items={navigationItems} />;
    }
  }, [section, navigationItems, reloadMenuConfig]);
  return <AppShell systemName="管理后台" homePath="/backstage" items={navigationItems}>{body}</AppShell>;
}

/** 用户详情字段（中文标签 + 值映射）。 */
function userDetailItems(detail: RecordValue): Array<{ label: string; children: React.ReactNode }> {
  return Object.entries(USER_DETAIL_LABELS).map(([key, label]) => {
    const value = detail[key];
    let text: unknown = value;
    if (key === 'gender') text = formatEnumLabel('gender', value);
    if (key === 'status') text = formatEnumLabel('userStatus', value);
    if (key === 'isSuperAdmin' || key === 'hasDingtalkBinding' || key === 'accountLocked') text = value === true ? '是' : value === false ? '否' : value;
    if (key === 'createdAt' || key === 'deactivatedAt') text = formatBeijingDateTime(String(value ?? ''));
    return { label, children: <span>{text === null || text === undefined || text === '' ? '—' : String(text)}</span> };
  });
}

function UserManagement() {
  const feedback = useFeedback();
  const { user } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const [dingtalkImportOpen, setDingtalkImportOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<RecordValue | null>(null);
  const [editing, setEditing] = useState(false);
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePreview, setRestorePreview] = useState<RecordValue | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    void http.get<RecordValue>(`/users/${detailId}`, { active: true }).then(setDetail).catch((error) => feedback.error(error, '用户详情加载失败'));
  }, [detailId, feedback]);

  const create = async (values: RecordValue) => {
    await http.post('/users', values);
    feedback.success('用户已创建，可生成激活邀请');
    setCreateOpen(false);
    setVersion((value) => value + 1);
  };
  const update = async (values: RecordValue) => {
    if (!detailId) return;
    if (detail && String(values.name ?? '') === String(detail.name ?? '') && values.gender === detail.gender) {
      feedback.info('未修改任何内容');
      setEditing(false);
      return;
    }
    await http.put(`/users/${detailId}`, values);
    feedback.success('用户资料已更新');
    setEditing(false);
    setVersion((value) => value + 1);
    setDetail(await http.get<RecordValue>(`/users/${detailId}`, { active: true }));
  };
  const issueActivation = async () => {
    if (!detailId) return;
    try {
      const result = await http.post<{ activationUrl: string }>(`/users/${detailId}/activation-invitations`, {});
      setInvitationUrl(result.activationUrl);
      feedback.success('激活邀请已生成，请安全地转交给目标员工');
    } catch (error) {
      feedback.error(error, '生成激活邀请失败');
    }
  };
  const issueReset = async () => {
    if (!detailId) return;
    try {
      const result = await http.post<{ resetUrl: string }>(`/users/${detailId}/password-reset-invitations`, {});
      setInvitationUrl(result.resetUrl);
      feedback.success('密码重置邀请已生成，请安全地转交给目标员工');
    } catch (error) {
      feedback.error(error, '生成密码重置邀请失败');
    }
  };
  const unlock = async () => {
    if (!detailId) return;
    try {
      await http.post(`/users/${detailId}/unlock`, {});
      feedback.success('账号已解锁');
      setDetail({ ...detail, accountLocked: false });
    } catch (error) {
      feedback.error(error, '解除登录锁定失败');
    }
  };
  const toggleSuperAdmin = async (appoint: boolean) => {
    if (!detailId) return;
    try {
      if (appoint) await http.post(`/users/${detailId}/super-admin`, {});
      else await http.delete(`/users/${detailId}/super-admin`, {});
      feedback.success(appoint ? '已任命为超级管理员' : '已降级为普通员工');
      setVersion((value) => value + 1);
      setDetail(await http.get<RecordValue>(`/users/${detailId}`, { active: true }));
    } catch (error) {
      feedback.error(error, appoint ? '任命超级管理员失败' : '降级超级管理员失败');
    }
  };
  const previewRestore = async (values: RecordValue) => {
    try {
      const rawIds = values.userIds;
      const userIds = Array.isArray(rawIds)
        ? rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
        : [];
      if (userIds.length === 0) {
        throw new Error('请至少选择一名已注销用户');
      }
      const result = await http.post<RecordValue>('/users/restorations/preview', { userIds });
      setRestorePreview(result);
      setRestoreOpen(false);
    } catch (error) {
      feedback.error(error, '恢复预览失败');
    }
  };
  const confirmRestore = async () => {
    const requestId = restorePreview?.restoreRequestId;
    const rawItems = restorePreview?.items;
    if (typeof requestId !== 'string' || !Array.isArray(rawItems)) return;
    const targets = rawItems.flatMap((item) => isRecord(item) && item.restorable === true && typeof item.userId === 'number' && typeof item.lifecycleVersion === 'number'
      ? [{ userId: item.userId, lifecycleVersion: item.lifecycleVersion }]
      : []);
    if (targets.length === 0) {
      feedback.error(new Error('没有可恢复的用户'), '恢复确认失败');
      return;
    }
    try {
      await http.post('/users/restorations/confirm', { restoreRequestId: requestId, targets });
      feedback.success(`已恢复 ${targets.length} 个用户`);
      setRestoreOpen(false);
      setRestorePreview(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '恢复用户失败');
    }
  };

  return (
    <>
      <DataTable
        key={version}
        title="用户管理"
        service="platform"
        endpoint="/users"
        pageKey="backstage-users"
        columns={USER_COLUMNS}
        filterFields={[
          { key: 'keyword', title: '姓名或手机号', type: 'text' },
          { key: 'status', title: '状态', type: 'enum', options: [{ label: '待激活', value: 'PENDING_ACTIVATION' }, { label: '正常', value: 'ACTIVE' }, { label: '已注销', value: 'DEACTIVATED' }] },
        ]}
        actions={<Space wrap><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建用户</Button><Button onClick={() => setDingtalkImportOpen(true)}>从钉钉导入</Button><Button onClick={() => setRestoreOpen(true)}>恢复已注销用户</Button></Space>}
        emptyAction={{ label: '去创建', onExecute: () => setCreateOpen(true) }}
        onRowClick={(row) => setDetailId(Number(row.id))}
        batchAction={{ label: '批量注销', danger: true, onExecute: async (userIds) => { await http.post('/users/deactivations/batch', { userIds: userIds.map(Number) }); } }}
      />
      <ResourceFormModal title="新建用户" open={createOpen} onCancel={() => setCreateOpen(false)} onSubmit={create} fields={[
        { key: 'name', label: '姓名', required: true, maxLength: 50 },
        { key: 'phone', label: '手机号', required: true, maxLength: 32 },
        { key: 'gender', label: '性别', type: 'select', required: true, options: [{ label: '男', value: 'MALE' }, { label: '女', value: 'FEMALE' }], width: 'narrow' },
      ]} />
      <DingtalkImportModal
        open={dingtalkImportOpen}
        onCancel={() => setDingtalkImportOpen(false)}
        onImported={() => setVersion((value) => value + 1)}
      />
      <Drawer title="用户详情" open={detailId !== null} onClose={() => { setDetailId(null); setInvitationUrl(null); }} width="min(92vw, 520px)">
        {detail ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions bordered column={1} size="small" items={userDetailItems(detail)} />
            <Space wrap>
              <Button onClick={() => setEditing(true)}>编辑资料</Button>
              {detail.status === 'PENDING_ACTIVATION' ? <ConfirmAction title="确认生成激活邀请？" description="将生成一次性激活链接，请通过安全渠道转交给目标员工。" okText="生成" onConfirm={() => void issueActivation()}><Button>生成激活邀请</Button></ConfirmAction> : null}
              {detail.status === 'ACTIVE' ? <ConfirmAction title="确认生成密码重置邀请？" description="将生成一次性密码重置链接，请通过安全渠道转交给目标员工。" okText="生成" onConfirm={() => void issueReset()}><Button>生成密码重置邀请</Button></ConfirmAction> : null}
              {detail.accountLocked === true ? <ConfirmAction title="确认解除登录锁定？" description="解除后该账号可立即重新尝试登录。" okText="解除锁定" danger onConfirm={() => void unlock()}><Button danger>解除登录锁定</Button></ConfirmAction> : null}
              {user?.isSuperAdmin ? detail.isSuperAdmin === true
                ? <Popconfirm title="确认将该用户降级为普通员工？" onConfirm={() => void toggleSuperAdmin(false)}><Button danger>降级超管</Button></Popconfirm>
                : <Popconfirm title="确认任命该用户为超级管理员？" onConfirm={() => void toggleSuperAdmin(true)}><Button>任命超管</Button></Popconfirm>
                : null}
            </Space>
            {invitationUrl ? <Card size="small" title="一次性邀请链接"><Input readOnly value={invitationUrl} aria-label="一次性邀请链接" /><Typography.Paragraph type="warning" style={{ margin: '8px 0 0' }}>链接仅在当前抽屉中展示，请通过安全渠道转交，不要复制到长期记录。</Typography.Paragraph></Card> : null}
          </Space>
        ) : <Typography.Text>正在加载...</Typography.Text>}
      </Drawer>
      <ResourceFormModal title="编辑用户资料" open={editing} onCancel={() => setEditing(false)} onSubmit={update} initialValues={detail ?? {}} submitDisabled={(values) => Boolean(detail && String(values.name ?? '') === String(detail.name ?? '') && values.gender === detail.gender)} fields={[
        { key: 'name', label: '姓名', required: true, maxLength: 50 },
        { key: 'gender', label: '性别', type: 'select', required: true, options: [{ label: '男', value: 'MALE' }, { label: '女', value: 'FEMALE' }], width: 'narrow' },
      ]} />
      <ResourceFormModal title="恢复已注销用户" open={restoreOpen} onCancel={() => { setRestoreOpen(false); setRestorePreview(null); }} onSubmit={previewRestore} fields={[
        { key: 'userIds', label: '已注销用户', type: 'remote-multi-select', required: true, remote: deactivatedUsersSource, placeholder: '按姓名或手机号搜索', width: 'full' },
      ]} submitText="生成恢复预览" />
      {restorePreview ? <Drawer title="恢复预览" open onClose={() => setRestorePreview(null)} width="min(92vw, 640px)">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {Array.isArray(restorePreview.items) ? restorePreview.items.map((item, index) => <Card key={index} size="small" title={isRecord(item) ? String(item.name ?? '—') : '用户'}>{isRecord(item) ? <RestorePreviewItem item={item} /> : String(item)}</Card>) : null}
          <Popconfirm title="确认恢复预览中全部可恢复用户？" onConfirm={() => void confirmRestore()}><Button type="primary">确认恢复</Button></Popconfirm>
        </Space>
      </Drawer> : null}
    </>
  );
}

/** 恢复预览逐目标展示（中文标签；不可恢复原因与将撤销的授权逐项呈现）。 */
function RestorePreviewItem({ item }: { item: RecordValue }) {
  const restorable = item.restorable === true;
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {Object.entries(RESTORE_ITEM_LABELS).filter(([key]) => key !== 'restorable').map(([key, label]) => {
        const value = item[key];
        if (value === undefined || value === null) return null;
        if (key === 'blockedReason') {
          return <div key={key}>{label}：<Tag color="red">{formatEnumLabel('restoreBlockedReason', value)}</Tag></div>;
        }
        if (key === 'restoreStatus') {
          return <div key={key}>{label}：{formatEnumLabel('userStatus', value)}</div>;
        }
        if (key === 'revokedGrants' && Array.isArray(value)) {
          return <div key={key}>{label}：{value.length === 0 ? '无' : value.map((grant) => isRecord(grant) ? `${String(grant.name ?? grant.functionCode)}（${formatEnumLabel('dataScope', grant.dataScope)}）` : String(grant)).join('、')}</div>;
        }
        if (key === 'removedDepartmentNames' && Array.isArray(value)) {
          return <div key={key}>{label}：{value.length === 0 ? '无' : value.join('、')}</div>;
        }
        if (key === 'positionCleared') {
          return <div key={key}>{label}：{value === true ? '是' : value === false ? '否' : String(value ?? '—')}</div>;
        }
        return <div key={key}>{label}：{String(value ?? '—')}</div>;
      })}
      <div>可恢复：{restorable ? <Tag color="green">是</Tag> : <Tag color="red">否</Tag>}</div>
    </Space>
  );
}

/** 人员权限页：姓名/部门/可进系统/可用功能 + 「修改权限」抽屉；批量授权沿用既有弹窗。 */
function PermissionEmployees() {
  const feedback = useFeedback();
  const { user } = useSession();
  const hidePermissionManage = user?.isSuperAdmin !== true;
  const [selectedIds, setSelectedIds] = useState<Array<string | number>>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [target, setTarget] = useState<{ id: number; name: string } | null>(null);
  const [version, setVersion] = useState(0);

  const batchGrant = async (values: RecordValue) => {
    if (selectedIds.length === 0) return;
    try {
      const grants = normalizeGrants(values.grants);
      const rawGroupIds = values.groupIds;
      const groupIds = Array.isArray(rawGroupIds)
        ? rawGroupIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
        : [];
      if (grants.length === 0 && groupIds.length === 0) {
        feedback.info('请至少添加一项功能授权或权限组');
        return;
      }
      await http.post('/permission/grants/batch', {
        userIds: selectedIds.map(Number),
        grants,
        groupIds,
      });
      feedback.success(`已为 ${selectedIds.length} 名员工追加授权`);
      setBatchOpen(false);
      setSelectedIds([]);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '批量授权失败');
    }
  };

  return <>
    <DataTable
      key={version}
      title="人员权限"
      service="platform"
      endpoint="/permission/employees"
      pageKey="backstage-permission-employees"
      columns={[
        { key: 'name', title: '姓名', sortable: true, render: (value: unknown, row: RecordValue) => <Space size={4}><span>{String(value ?? '—')}</span>{row.isSuperAdmin === true ? <Tag color="gold">超管</Tag> : null}</Space> },
        { key: 'departments', title: '部门', render: (value: unknown) => { const list = asStringList(value); return list.length > 0 ? list.join('、') : '—'; } },
        { key: 'systems', title: '可进系统', render: (value: unknown, row: RecordValue) => (row.isSuperAdmin === true ? '全部系统' : <EllipsisLines items={asStringList(value)} lineChars={10} />) },
        { key: 'grantsSummary', title: '可用功能', render: (value: unknown, row: RecordValue) => (row.isSuperAdmin === true ? '全部功能' : <EllipsisLines items={asStringList(value)} lineChars={15} />) },
      ]}
      filterFields={[{ key: 'keyword', title: '姓名或手机号', type: 'text' }]}
      onSelectionChange={setSelectedIds}
      actions={<Button disabled={selectedIds.length === 0} onClick={() => setBatchOpen(true)}>批量追加授权</Button>}
      batchAction={{ label: '批量撤销全部可管理授权', danger: true, confirmationDescription: '撤销后，已授予的功能将立即失效。', onExecute: async (ids) => { await http.post('/permission/revocations/batch', { userIds: ids.map(Number) }); } }}
      rowActions={(row) => <Button size="small" type="primary" ghost onClick={() => setTarget({ id: Number(row.id), name: String(row.name ?? '') })}>修改权限</Button>}
    />
    <PermissionGrantDrawer target={target} hidePermissionManage={hidePermissionManage} onClose={() => setTarget(null)} onSaved={() => setVersion((value) => value + 1)} />
    <ResourceFormModal title={`批量追加授权（${selectedIds.length} 人）`} open={batchOpen} onCancel={() => setBatchOpen(false)} onSubmit={batchGrant} initialValues={{ grants: [], groupIds: [] }} submitDisabled={(values) => {
      const grants = Array.isArray(values.grants) ? values.grants : [];
      const groupIds = Array.isArray(values.groupIds) ? values.groupIds : [];
      return grants.length === 0 && groupIds.length === 0;
    }} fields={[
      { key: 'grants', label: '直接授权', type: 'permission-grants', permissionVariant: 'tree', width: 'full', hidePermissionManage },
      { key: 'groupIds', label: '权限组', type: 'remote-multi-select', remote: permissionGroupsSource, placeholder: '选择一个或多个权限组展开追加', width: 'full' },
    ]} />
  </>;
}

/** 将接口返回的字符串数组字段规范为字符串列表（非数组/空项剔除）。 */
function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter((item) => item.trim()) : [];
}

function PermissionGroups() {
  const feedback = useFeedback();
  const { user } = useSession();
  const hidePermissionManage = user?.isSuperAdmin !== true;
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [group, setGroup] = useState<RecordValue | null>(null);
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!groupId) {
      setGroup(null);
      return;
    }
    void http.get<RecordValue>(`/permission/groups/${groupId}`, { active: true }).then(setGroup).catch((error) => feedback.error(error, '权限组详情加载失败'));
  }, [feedback, groupId]);
  const create = async (values: RecordValue) => {
    try {
      await http.post('/permission/groups', { name: values.name, description: values.description, items: normalizeGrants(values.items) });
      feedback.success('权限组已创建');
      setOpen(false);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '创建权限组失败');
    }
  };
  const update = async (values: RecordValue) => {
    if (!groupId) return;
    try {
      await http.put(`/permission/groups/${groupId}`, { name: values.name, description: values.description, items: normalizeGrants(values.items) });
      feedback.success('权限组已更新');
      setEditing(false);
      setVersion((value) => value + 1);
      setGroup(await http.get<RecordValue>(`/permission/groups/${groupId}`, { active: true }));
    } catch (error) {
      feedback.error(error, '更新权限组失败');
    }
  };
  const editingItems = Array.isArray(group?.items)
    ? (group.items as Array<RecordValue>)
      .filter((item) => typeof item.functionCode === 'string' && typeof item.dataScope === 'string')
      .map((item) => ({ functionCode: String(item.functionCode), dataScope: item.dataScope as GrantItem['dataScope'] }))
    : [];
  return <>
    <DataTable key={version} title="权限组" service="platform" endpoint="/permission/groups" pageKey="backstage-permission-groups" columns={[...LIST_COLUMNS, { key: 'itemCount', title: '功能数' }]} onRowClick={(row) => setGroupId(Number(row.id))} actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建权限组</Button>} emptyAction={{ label: '去创建', onExecute: () => setOpen(true) }} batchAction={{ label: '删除权限组', danger: true, onExecute: async (groupIds) => { await http.post('/permission/groups/batch-delete', { groupIds: groupIds.map(Number) }); } }} />
    <ResourceFormModal title="新建权限组" open={open} onCancel={() => setOpen(false)} onSubmit={create} initialValues={{ items: [] }} fields={[{ key: 'name', label: '名称', required: true, maxLength: 50 }, { key: 'description', label: '说明', type: 'textarea', maxLength: 500 }, { key: 'items', label: '授权明细', type: 'permission-grants', permissionVariant: 'matrix', required: true, width: 'full', hidePermissionManage }]} />
    <Drawer title="权限组详情" open={groupId !== null} onClose={() => setGroupId(null)} width="min(92vw, 640px)">
      {group ? <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card size="small" title="基本信息">名称：{String(group.name ?? '—')}；说明：{String(group.description ?? '—')}</Card>
        <Card size="small" title="授权明细">{Array.isArray(group.items) && group.items.length > 0 ? group.items.map((item, index) => <Typography.Paragraph key={index}>{isRecord(item) ? `${String(item.name ?? item.functionCode)}（${formatEnumLabel('dataScope', item.dataScope)}）${item.valid === false ? '，已失效' : ''}` : String(item)}</Typography.Paragraph>) : <Typography.Text type="secondary">当前是空权限组。</Typography.Text>}</Card>
        <Button type="primary" onClick={() => setEditing(true)}>编辑权限组</Button>
      </Space> : <Typography.Text>正在加载...</Typography.Text>}
    </Drawer>
    <ResourceFormModal title="编辑权限组" open={editing} onCancel={() => setEditing(false)} onSubmit={update} initialValues={{ name: group?.name, description: group?.description, items: editingItems }} fields={[{ key: 'name', label: '名称', required: true, maxLength: 50 }, { key: 'description', label: '说明', type: 'textarea', maxLength: 500 }, { key: 'items', label: '授权明细', type: 'permission-grants', permissionVariant: 'matrix', required: true, width: 'full', hidePermissionManage }]} />
  </>;
}

const SETTING_LABELS: Readonly<Record<string, string>> = {
  'session.idle.timeout.seconds': '普通会话空闲超时',
  'session.idle.remember.seconds': '记住我空闲超时',
  'session.abs.timeout.seconds': '普通会话绝对过期',
  'session.abs.remember.seconds': '记住我绝对过期',
  'login.account.max.attempts': '账号锁失败次数',
  'login.account.lock.seconds': '账号锁定时长',
  'login.ip.window.seconds': 'IP 锁窗口',
  'login.ip.max.attempts': 'IP 锁失败次数',
  'login.ip.lock.seconds': 'IP 锁定时长',
  'invitation.valid.seconds': '邀请有效期',
  'query.default.window.days': '默认查询窗口',
  'export.max.rows': '单次导出上限',
  'backup.retention.days': '备份保留天数',
  'upload.unassociated.image.retention.hours': '图片保留时长',
  'approval.timeout.cancel.days': '审批超时取消',
  'ui.notification.duration.seconds': '悬浮通知时长',
  'log.cleanup.interval.hours': '清理执行间隔',
  'log.cleanup.error_log.days': '错误日志保留',
  'log.cleanup.security_log.days': '安全日志保留',
};

/** 平台设置在界面上的单位与存储换算规则。 */
const SETTING_PRESENTATIONS: Readonly<Record<string, SystemSettingPresentation>> = {
  'session.idle.timeout.seconds': {
    unit: '分钟', storedValueFactor: 60, integer: true, step: 1,
  },
  'session.idle.remember.seconds': {
    unit: '分钟', storedValueFactor: 60, integer: true, step: 1,
  },
  'session.abs.timeout.seconds': {
    unit: '分钟', storedValueFactor: 60, integer: true, step: 1,
  },
  'session.abs.remember.seconds': {
    unit: '分钟', storedValueFactor: 60, integer: true, step: 1,
  },
  'login.account.max.attempts': {
    unit: '次', integer: true,
  },
  'login.account.lock.seconds': {
    unit: '分钟', storedValueFactor: 60, integer: true, step: 1,
  },
  'login.ip.window.seconds': {
    unit: '分钟', storedValueFactor: 60, integer: true, step: 1,
  },
  'login.ip.max.attempts': {
    unit: '次', integer: true,
  },
  'login.ip.lock.seconds': {
    unit: '分钟', storedValueFactor: 60, integer: true, step: 1,
  },
  'invitation.valid.seconds': {
    unit: '分钟', storedValueFactor: 60, integer: true, step: 1,
  },
  'query.default.window.days': {
    unit: '天', integer: true,
  },
  'export.max.rows': {
    unit: '行', integer: true,
  },
  'backup.retention.days': {
    unit: '天', integer: true,
  },
  'upload.unassociated.image.retention.hours': {
    unit: '小时', integer: true,
  },
  'approval.timeout.cancel.days': {
    unit: '天', integer: true,
  },
  'ui.notification.duration.seconds': {
    unit: '秒', integer: true,
  },
  'log.cleanup.interval.hours': {
    unit: '小时', integer: true,
  },
  'log.cleanup.error_log.days': {
    unit: '天', integer: true,
  },
  'log.cleanup.security_log.days': {
    unit: '天', integer: true,
  },
};

const SETTING_GROUPS: SystemSettingsGroup[] = [
  {
    id: 'session',
    title: '会话与安全',
    keys: [
      'session.idle.timeout.seconds',
      'session.idle.remember.seconds',
      'session.abs.timeout.seconds',
      'session.abs.remember.seconds',
      'login.account.max.attempts',
      'login.account.lock.seconds',
      'login.ip.window.seconds',
      'login.ip.max.attempts',
      'login.ip.lock.seconds',
      'invitation.valid.seconds',
    ],
  },
  {
    id: 'query-export',
    title: '查询与导出',
    keys: ['query.default.window.days', 'export.max.rows'],
  },
  {
    id: 'backup-files',
    title: '备份与文件',
    keys: ['backup.retention.days', 'upload.unassociated.image.retention.hours'],
  },
  {
    id: 'approval',
    title: '审批',
    keys: ['approval.timeout.cancel.days'],
  },
  {
    id: 'notifications',
    title: '界面通知',
    keys: ['ui.notification.duration.seconds'],
  },
  {
    id: 'log-cleanup',
    title: '日志清理',
    keys: [
      'log.cleanup.interval.hours',
      'log.cleanup.error_log.days',
      'log.cleanup.security_log.days',
    ],
  },
];

const LOG_CLEANUP_KEYS = [
  'log.cleanup.interval.hours',
  'log.cleanup.operation_log.create.days',
  'log.cleanup.operation_log.update.days',
  'log.cleanup.operation_log.delete.days',
  'log.cleanup.operation_log.export.days',
  'log.cleanup.operation_log.query.days',
  'log.cleanup.error_log.days',
  'log.cleanup.security_log.days',
];

const OPERATION_LOG_KEYS = [
  'log.cleanup.operation_log.create.days',
  'log.cleanup.operation_log.update.days',
  'log.cleanup.operation_log.delete.days',
  'log.cleanup.operation_log.export.days',
  'log.cleanup.operation_log.query.days',
];

const OPERATION_LOG_LABELS: Readonly<Record<string, string>> = {
  'log.cleanup.operation_log.create.days': '新增',
  'log.cleanup.operation_log.update.days': '修改',
  'log.cleanup.operation_log.delete.days': '删除',
  'log.cleanup.operation_log.export.days': '导出',
  'log.cleanup.operation_log.query.days': '查询',
};

/** 系统设置书签页：左侧目录点击后滚动到对应分组，地址栏同步 #hash。 */
function SettingsBookmarkPage() {
  const [unifiedDays, setUnifiedDays] = useState<number | null>(null);

  const applyUnifiedOperationLog = (form: FormInstance) => {
    if (unifiedDays === null || unifiedDays === undefined) {
      return;
    }
    form.setFieldsValue(Object.fromEntries(OPERATION_LOG_KEYS.map((key) => [key, unifiedDays])));
  };

  const groups: SystemSettingsGroup[] = SETTING_GROUPS.map((group) => (
    group.id === 'log-cleanup'
      ? {
          ...group,
          saveKeys: LOG_CLEANUP_KEYS,
          renderExtra: ({ form, settings }) => {
            const operationLogItems = OPERATION_LOG_KEYS
              .map((key) => settings.find((setting) => setting.key === key))
              .filter((setting): setting is SystemSettingItem => Boolean(setting));
            return (
              <Card size="small" title="操作日志" style={{ marginTop: 8 }}>
                <Row gutter={[16, 0]}>
                  {operationLogItems.map((item) => (
                    <Col xs={24} sm={12} lg={8} key={item.key}>
                      <Form.Item name={item.key} label={OPERATION_LOG_LABELS[item.key] ?? SETTING_LABELS[item.key] ?? item.label} rules={[{ required: true }]}>
                        <InputNumber min={item.min} max={item.max} precision={0} addonAfter="天" style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  ))}
                </Row>
                <Space>
                  <InputNumber
                    value={unifiedDays}
                    onChange={setUnifiedDays}
                    min={0}
                    max={36_500}
                    addonAfter="天"
                    placeholder="统一天数"
                    style={{ width: 180 }}
                  />
                  <Button onClick={() => applyUnifiedOperationLog(form)}>统一修改</Button>
                </Space>
              </Card>
            );
          },
        }
      : group
  ));

  return (
    <SystemSettingsPage
      service="platform"
      endpoint="/system-settings"
      groups={groups}
      labels={SETTING_LABELS}
      presentations={SETTING_PRESENTATIONS}
      save={(patches) => http.put('/system-settings', { patches })}
      extraSections={[
        { id: 'dingtalk-import', title: '钉钉员工导入', content: <DingtalkImportSettingsCard /> },
        { id: 'system-status', title: '系统状态', content: <SystemStatusTab /> },
      ]}
    />
  );
}

interface DingtalkImportSettingsStatus {
  appKeyConfigured: boolean;
  appSecretConfigured: boolean;
  corpIdConfigured: boolean;
  defaultPasswordConfigured: boolean;
  ready: boolean;
}

type DingtalkImportSettingsDraft = Record<'appKey' | 'appSecret' | 'corpId' | 'defaultPassword', string>;

/** 钉钉导入设置仅展示配置状态；敏感值保存后立即清空，后端也不会回显。 */
function DingtalkImportSettingsCard() {
  const feedback = useFeedback();
  const [status, setStatus] = useState<DingtalkImportSettingsStatus | null>(null);
  const [draft, setDraft] = useState<DingtalkImportSettingsDraft>({ appKey: '', appSecret: '', corpId: '', defaultPassword: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setStatus(await http.get<DingtalkImportSettingsStatus>('/system-settings/dingtalk-import', { active: true }));
    } catch (error) {
      feedback.error(error, '钉钉导入设置加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const updateDraft = (key: keyof DingtalkImportSettingsDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    const patches = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim() !== ''));
    if (Object.keys(patches).length === 0) {
      feedback.info('请至少填写一项需要更新的配置');
      return;
    }
    const confirmed = await feedback.confirm({
      title: '确认保存钉钉员工导入配置？',
      content: '保存后不会再次显示 AppSecret 和默认密码的明文。',
      okText: '保存',
    });
    if (!confirmed) {
      return;
    }
    setSaving(true);
    try {
      const nextStatus = await http.put<DingtalkImportSettingsStatus>('/system-settings/dingtalk-import', patches);
      setStatus(nextStatus);
      setDraft({ appKey: '', appSecret: '', corpId: '', defaultPassword: '' });
      feedback.success('钉钉导入配置已保存');
    } catch (error) {
      feedback.error(error, '钉钉导入配置保存失败');
    } finally {
      setSaving(false);
    }
  };

  const configurationStatus = (configured: boolean) => configured ? <Tag color="success">已配置</Tag> : <Tag>未配置</Tag>;

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 0]}>
          <Col xs={24} md={12}>
            <Typography.Paragraph style={{ marginBottom: 6 }}>AppKey {configurationStatus(status?.appKeyConfigured === true)}</Typography.Paragraph>
            <Input aria-label="钉钉 AppKey" autoComplete="off" value={draft.appKey} onChange={(event) => updateDraft('appKey', event.target.value)} maxLength={128} />
          </Col>
          <Col xs={24} md={12}>
            <Typography.Paragraph style={{ marginBottom: 6 }}>AppSecret {configurationStatus(status?.appSecretConfigured === true)}</Typography.Paragraph>
            <Input.Password aria-label="钉钉 AppSecret" autoComplete="new-password" value={draft.appSecret} onChange={(event) => updateDraft('appSecret', event.target.value)} maxLength={512} />
          </Col>
          <Col xs={24} md={12}>
            <Typography.Paragraph style={{ marginBottom: 6 }}>组织 CorpId {configurationStatus(status?.corpIdConfigured === true)}</Typography.Paragraph>
            <Input aria-label="钉钉组织 CorpId" autoComplete="off" value={draft.corpId} onChange={(event) => updateDraft('corpId', event.target.value)} maxLength={128} />
          </Col>
          <Col xs={24} md={12}>
            <Typography.Paragraph style={{ marginBottom: 6 }}>导入默认密码 {configurationStatus(status?.defaultPasswordConfigured === true)}</Typography.Paragraph>
            <Input.Password aria-label="钉钉导入默认密码" autoComplete="new-password" value={draft.defaultPassword} onChange={(event) => updateDraft('defaultPassword', event.target.value)} maxLength={32} />
          </Col>
        </Row>
        <Space>
          <Button onClick={() => void load()}>刷新状态</Button>
          <Button type="primary" loading={saving} onClick={() => void save()}>保存钉钉导入配置</Button>
        </Space>
      </Space>
    </Spin>
  );
}

/** 系统设置：系统设置（书签页）+ 菜单管理。 */
function PlatformSettings({ onMenuSaved }: { onMenuSaved: () => void }) {
  return (
    <Card>
      <Tabs
        items={[
          { key: 'settings', label: '系统设置', children: <SettingsBookmarkPage /> },
          { key: 'menu', label: '菜单管理', children: <MenuManagementTab systemCode="BACKSTAGE" defaults={NAVIGATION} onSaved={onMenuSaved} /> },
        ]}
      />
    </Card>
  );
}

/** 系统开放状态切换（原「系统与业务结构」状态能力迁移；backstage 恒开放不可调）。 */
function SystemStatusTab() {
  const feedback = useFeedback();
  const [systems, setSystems] = useState<Array<{ code: string; name: string; productStatus: 'OPEN' | 'COMING_SOON' }>>([]);
  const [loading, setLoading] = useState(true);
  const [updatingCode, setUpdatingCode] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    try {
      const result = await http.get<{ systems?: Array<{ code: string; name: string; productStatus: 'OPEN' | 'COMING_SOON' }> }>('/systems', { active: true });
      setSystems((result.systems ?? []).filter((system) => system.code !== 'BACKSTAGE'));
    } catch (error) {
      feedback.error(error, '系统状态加载失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const changeStatus = async (code: string, productStatus: 'OPEN' | 'COMING_SOON') => {
    setUpdatingCode(code);
    try {
      await http.put(`/systems/${code}/status`, { productStatus });
      feedback.success('系统状态已更新');
      setSystems((current) => current.map((system) => (system.code === code ? { ...system, productStatus } : system)));
    } catch (error) {
      feedback.error(error, '系统状态更新失败');
    } finally {
      setUpdatingCode(null);
    }
  };
  if (loading) return <Spin tip="正在加载..." />;
  if (systems.length === 0) return <Typography.Text type="secondary">当前没有可调整状态的业务系统。</Typography.Text>;
  return <Space direction="vertical" size="small" style={{ width: '100%' }}>
    {systems.map((system) => {
      const isOpen = system.productStatus === 'OPEN';
      const switchControl = <Switch
        checked={isOpen}
        checkedChildren="开放"
        unCheckedChildren="即将上线"
        loading={updatingCode === system.code}
        disabled={updatingCode !== null}
        onChange={() => {
          // 状态变更统一由外层确认框的 onConfirm 触发，避免确认前直接切换。
        }}
      />;
      return <Card
        key={system.code}
        size="small"
        title={system.name}
        extra={isOpen
          ? <ConfirmAction title={`确认关闭“${system.name}”？`} description="关闭后该业务系统入口将变为“即将上线”。" okText="设为即将上线" danger onConfirm={() => void changeStatus(system.code, 'COMING_SOON')}>{switchControl}</ConfirmAction>
          : <ConfirmAction title={`确认开放“${system.name}”？`} description="开放后该业务系统入口可被有权限的用户进入。" okText="设为开放" onConfirm={() => void changeStatus(system.code, 'OPEN')}>{switchControl}</ConfirmAction>}
        styles={{ body: { display: 'none' } }}
      />;
    })}
  </Space>;
}

function OperationLogs() {
  return <DataTable title="操作日志" service="platform" endpoint="/operation-logs" pageKey="backstage-operation-logs" columns={[{ key: 'operatorName', title: '操作者', sortable: true }, { key: 'actionType', title: '操作', render: (value: unknown) => <StatusTag value={value} enumKind="operationAction" />, sortable: true }, { key: 'summary', title: '摘要', sortable: true }, { key: 'createdAt', title: '时间', sortable: true }]} filterFields={[{ key: 'system', title: '系统', type: 'enum', options: OPERATION_SYSTEM_OPTIONS }, { key: 'feature', title: '功能', type: 'enum', options: operationFeatureOptions }, { key: 'operatorId', title: '操作者', type: 'remote', remote: permissionEmployeesSource }, { key: 'departmentId', title: '部门', type: 'tree', remote: operationLogDepartmentTreeSource }, { key: 'actionType', title: '操作', type: 'enum', options: [{ label: '新增', value: 'CREATE' }, { label: '修改', value: 'UPDATE' }, { label: '删除', value: 'DELETE' }, { label: '导出', value: 'EXPORT' }, { label: '查询', value: 'QUERY' }] }, { key: 'createdAt', title: '时间', type: 'date' }]} exportConfig={{ allEndpoint: '/operation-logs/export', filename: 'operation-logs.xlsx', method: 'POST' }} />;
}

function SystemLogs() {
  const feedback = useFeedback();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<RecordValue | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (detailId === null) {
      setDetail(null);
      return;
    }
    void http.get<RecordValue>(`/system-logs/errors/${detailId}`, { active: true }).then(setDetail).catch((error) => feedback.error(error, '错误日志详情加载失败'));
  }, [detailId, feedback]);
  const dispose = async (id: number, status: 'HANDLED' | 'IGNORED') => {
    try {
      await http.post(`/system-logs/errors/${id}/dispose`, { status });
      feedback.success(status === 'HANDLED' ? '错误日志已标记为已处理' : '错误日志已忽略');
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '处置错误日志失败');
    }
  };
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <Tabs
      items={[
        { key: 'errors', label: '错误日志', children: <DataTable key={`errors-${version}`} title="错误日志" service="platform" endpoint="/system-logs/errors" pageKey="backstage-error-logs" columns={ERROR_LOG_COLUMNS} filterFields={[{ key: 'service', title: '服务', type: 'text' }, { key: 'status', title: '状态', type: 'enum', options: [{ label: '待处理', value: 'PENDING' }, { label: '已处理', value: 'HANDLED' }, { label: '已忽略', value: 'IGNORED' }] }]} onRowClick={(row) => setDetailId(Number(row.id))} exportConfig={{ allEndpoint: '/system-logs/errors/export', filename: 'errors-logs.xlsx', method: 'POST' }} rowActions={(row) => row.status === 'PENDING' ? <Space size="small"><Popconfirm title="确认标记为已处理？" onConfirm={() => void dispose(Number(row.id), 'HANDLED')}><Button size="small">已处理</Button></Popconfirm><Popconfirm title="确认忽略此错误？" onConfirm={() => void dispose(Number(row.id), 'IGNORED')}><Button size="small" danger>忽略</Button></Popconfirm></Space> : null} /> },
        { key: 'security', label: '安全日志', children: <DataTable title="安全日志" service="platform" endpoint="/system-logs/security" pageKey="backstage-security-logs" columns={SECURITY_LOG_COLUMNS} filterFields={[{ key: 'eventType', title: '事件类型', type: 'enum', options: SECURITY_EVENT_TYPE_OPTIONS }, { key: 'actorId', title: '操作者', type: 'remote', remote: permissionEmployeesSource }, { key: 'targetUserId', title: '目标用户', type: 'remote', remote: permissionEmployeesSource }, { key: 'result', title: '结果', type: 'enum', options: [{ label: '成功', value: 'SUCCESS' }, { label: '失败', value: 'FAILURE' }] }]} exportConfig={{ allEndpoint: '/system-logs/security/export', filename: 'security-logs.xlsx', method: 'POST' }} /> },
      ]}
    />
    <Drawer title="错误日志详情" open={detailId !== null} onClose={() => setDetailId(null)} width="min(92vw, 620px)">{detail ? <Descriptions bordered column={1} size="small" items={errorLogDetailItems(detail)} /> : <Typography.Text>正在加载...</Typography.Text>}</Drawer>
  </Space>;
}

function Announcements() {
  const feedback = useFeedback();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const changeStatus = async (id: number, action: 'publish' | 'revoke') => {
    try {
      await http.post(`/announcements/${id}/${action}`, {});
      feedback.success(action === 'publish' ? '公告已发布' : '公告已撤回');
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, action === 'publish' ? '发布公告失败' : '撤回公告失败');
    }
  };
  return <>
    <DataTable key={version} title="系统公告" service="platform" endpoint="/announcements" pageKey="backstage-announcements" columns={[{ key: 'title', title: '标题', sortable: true }, { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} enumKind="announcementStatus" />, sortable: true }, { key: 'publishedAt', title: '发布时间', sortable: true }, { key: 'createdAt', title: '创建时间' }, { key: 'updatedAt', title: '更新时间' }]} filterFields={[{ key: 'status', title: '状态', type: 'enum', options: [{ label: '草稿', value: 'DRAFT' }, { label: '展示中', value: 'PUBLISHING' }, { label: '已撤回', value: 'REVOKED' }] }]} actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建公告</Button>} emptyAction={{ label: '去创建', onExecute: () => setOpen(true) }} batchAction={{ label: '删除公告', danger: true, onExecute: async (ids) => { await http.delete('/announcements/batch', { ids: ids.map(Number) }); setVersion((value) => value + 1); } }} rowActions={(row) => { const status = String(row.status ?? ''); return <Space size="small">{status === 'DRAFT' ? <Popconfirm title="确认发布此公告？" onConfirm={() => void changeStatus(Number(row.id), 'publish')}><Button size="small">发布</Button></Popconfirm> : null}{status === 'PUBLISHING' ? <Popconfirm title="确认撤回此公告？" onConfirm={() => void changeStatus(Number(row.id), 'revoke')}><Button size="small" danger>撤回</Button></Popconfirm> : null}</Space>; }} />
    <ResourceFormModal title="新建公告" open={open} onCancel={() => setOpen(false)} onSubmit={async (values) => { await http.post('/announcements', values); feedback.success('公告草稿已创建'); setOpen(false); setVersion((value) => value + 1); }} fields={[{ key: 'title', label: '标题', required: true, maxLength: 200, width: 'wide' }, { key: 'content', label: '内容', type: 'textarea', maxLength: 10000 }]} />
  </>;
}

function ReleaseLogs() {
  return <DataTable title="更新日志" service="platform" endpoint="/release-logs" pageKey="backstage-release-logs" columns={[...LIST_COLUMNS, { key: 'version', title: '版本' }, { key: 'subjects', title: '内容' }]} />;
}

/** 数据备份与恢复：书签式两页签；恢复预检在同一抽屉内步骤切换（预检 → 确认）。 */
function Backups() {
  const feedback = useFeedback();
  const { user } = useSession();
  const [version, setVersion] = useState(0);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreStep, setRestoreStep] = useState<'form' | 'precheck' | 'waiting'>('form');
  const [precheck, setPrecheck] = useState<RecordValue | null>(null);
  /** 可恢复的已完成备份（供预检选择；仅展示类型与完成时间，不展示敏感元数据）。 */
  const [backupOptions, setBackupOptions] = useState<Array<{ label: string; value: number }>>([]);
  const [backupOptionsLoading, setBackupOptionsLoading] = useState(false);
  const [form] = Form.useForm<RecordValue>();
  const loadBackupOptions = async () => {
    setBackupOptionsLoading(true);
    try {
      const result = await http.get<{ data?: Array<RecordValue> }>('/backups?page=1&pageSize=50', { active: true });
      setBackupOptions((result.data ?? [])
        .filter((row) => row.status === 'SUCCEEDED')
        .map((row) => ({ label: `#${String(row.id)} ${formatEnumLabel('backupType', row.taskType)}（${row.finishedAt ? formatBeijingDateTime(String(row.finishedAt)) : '—'}）`, value: Number(row.id) })));
    } catch (error) {
      feedback.error(error, '备份列表加载失败');
    } finally {
      setBackupOptionsLoading(false);
    }
  };
  useEffect(() => {
    if (restoreOpen) void loadBackupOptions();
  }, [restoreOpen]);
  const submitPrecheck = async (values: RecordValue) => {
    try {
      const backupId = Number(values.backupId);
      const result = await http.post<RecordValue>('/restores/precheck', { backupId });
      setPrecheck({ ...result, backupId });
      // 预检等待（backstage PRD §10，问题7 修复）：普通备份运行中停留在预检等待，
      // 不拒绝确认；自动轮询直到放行再进入确认步骤
      setRestoreStep(result.waitingForBackup ? 'waiting' : 'precheck');
    } catch (error) {
      feedback.error(error, '恢复预检失败');
    }
  };
  // 预检等待轮询：普通备份运行中每 5s 重新预检，放行（ready）后进入确认步骤
  useEffect(() => {
    if (restoreStep !== 'waiting' || !precheck || typeof precheck.backupId !== 'number') return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const result = await http.post<RecordValue>('/restores/precheck', { backupId: precheck.backupId });
          setPrecheck({ ...result, backupId: precheck.backupId });
          if (!result.waitingForBackup) {
            setRestoreStep('precheck');
          }
        } catch {
          // 轮询失败保留等待状态，下一轮重试
        }
      })();
    }, 5_000);
    return () => clearInterval(timer);
  }, [restoreStep, precheck]);
  const confirmRestore = async (values: RecordValue) => {
    if (!precheck || typeof precheck.backupId !== 'number') return;
    try {
      await http.post('/restores/confirm', { backupId: precheck.backupId, note: values.note, proceedWithoutEmergency: values.proceedWithoutEmergency === true });
      feedback.success('恢复任务已确认，系统将先执行紧急备份');
      setRestoreOpen(false);
      setRestoreStep('form');
      setPrecheck(null);
      form.resetFields();
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '确认恢复失败');
    }
  };
  const immediateBackup = async () => {
    try {
      await http.post('/backups/immediate', {});
      feedback.success('立即备份任务已提交');
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '提交备份任务失败');
    }
  };
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <Tabs
      items={[
        { key: 'backups', label: '数据备份', children: <DataTable key={`backups-${version}`} title="数据备份" service="platform" endpoint="/backups" pageKey="backstage-backups" columns={BACKUP_COLUMNS} actions={<Space><ConfirmAction title="确认立即备份？" description="将立即触发一次数据备份任务。" okText="立即备份" onConfirm={() => void immediateBackup()}><Button icon={<ReloadOutlined />}>立即备份</Button></ConfirmAction>{user?.isSuperAdmin ? <Button danger onClick={() => { setRestoreOpen(true); setRestoreStep('form'); setPrecheck(null); }}>恢复</Button> : null}</Space>} /> },
        { key: 'restores', label: '恢复记录', children: <DataTable key={`restores-${version}`} title="恢复记录" service="platform" endpoint="/restores" pageKey="backstage-restores" columns={RESTORE_COLUMNS} /> },
      ]}
    />
    <Drawer title="数据库恢复" open={restoreOpen} onClose={() => { setRestoreOpen(false); setRestoreStep('form'); setPrecheck(null); form.resetFields(); }} width="min(92vw, 620px)">
      {restoreStep === 'form' ? (
        <Form form={form} layout="vertical" onFinish={(values) => void submitPrecheck(values)}>
          <Form.Item name="backupId" label="待恢复备份" rules={[{ required: true, message: '请选择待恢复备份' }]}><Select showSearch optionFilterProp="label" loading={backupOptionsLoading} placeholder="选择已完成备份" options={backupOptions} /></Form.Item>
          <Alert type="warning" showIcon message="恢复会覆盖当前数据库。确认后服务端会先创建紧急备份；紧急备份失败时只有明确勾选风险确认才能继续。" />
          <Button type="primary" htmlType="submit" style={{ marginTop: 16 }}>执行预检</Button>
        </Form>
      ) : restoreStep === 'waiting' && precheck ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert type="info" showIcon message={`普通备份运行中（#${String(precheck.runningBackupId ?? '')}），恢复停留在预检等待阶段，系统将自动等待其完成后进入确认。`} />
          <Spin tip="等待普通备份完成..." />
        </Space>
      ) : precheck ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions bordered column={1} size="small" items={restorePrecheckItems(precheck)} />
          <Form layout="vertical" onFinish={(values) => void confirmRestore(values)}>
            <Form.Item name="note" label="恢复说明"><Input.TextArea maxLength={500} rows={2} /></Form.Item>
            <Form.Item name="proceedWithoutEmergency" label="紧急备份失败时，已人工确认风险并继续" valuePropName="checked"><Checkbox /></Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">确认恢复</Button>
              <Button onClick={() => setRestoreStep('form')}>返回上一步</Button>
            </Space>
          </Form>
        </Space>
      ) : null}
    </Drawer>
  </Space>;
}

/** 健康状态专属布局：服务探针卡片 + 任务概览 + 磁盘状态 + 按模块/任务类型分组。 */
function HealthStatusPage() {
  const feedback = useFeedback();
  const [data, setData] = useState<RecordValue | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        setData(await http.get<RecordValue>('/health-status', { active: true }));
      } catch (error) {
        feedback.error(error, '健康状态加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [feedback]);
  if (loading) return <Spin tip="正在加载..." />;
  if (!data) return <Alert type="error" message="健康状态暂不可用" />;
  const services = Array.isArray(data.services) ? data.services as Array<RecordValue> : [];
  const tasks = isRecord(data.tasks) ? data.tasks : {};
  const overview = isRecord(tasks.overview) ? tasks.overview : {};
  const byModuleAndType = Array.isArray(tasks.byModuleAndType) ? tasks.byModuleAndType as Array<RecordValue> : [];
  const disk = isRecord(data.disk) ? data.disk : {};
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <Card title="服务探针" size="small">
      <Space wrap size={[12, 12]}>
        {services.map((service) => {
          const alive = service.alive === true;
          const ready = service.ready === true;
          return <Card key={String(service.name)} size="small" style={{ minWidth: 180 }}>
            <Space direction="vertical" size="small">
              <Typography.Text strong>{String(service.name)}</Typography.Text>
              <Space size="small">
                <Tag color={alive ? 'green' : 'red'}>存活 {alive ? '正常' : '异常'}</Tag>
                {service.ready === null ? <Tag>就绪未配置</Tag> : <Tag color={ready ? 'green' : 'red'}>就绪 {ready ? '正常' : '异常'}</Tag>}
              </Space>
            </Space>
          </Card>;
        })}
      </Space>
    </Card>
    <Card title="后台任务概览" size="small">
      <Space wrap size={[16, 16]}>
        {([['pendingEnqueue', '待入队'], ['queued', '排队中'], ['running', '执行中'], ['leaseAnomalies', '租约异常'], ['failed24h', '近 24 小时失败']] as Array<[string, string]>).map(([key, label]) => (
          <div key={key}><Typography.Text type="secondary">{label}</Typography.Text><div style={{ fontSize: 18, fontWeight: 600 }}>{String(overview[key] ?? '—')}</div></div>
        ))}
        <div><Typography.Text type="secondary">最近失败时间</Typography.Text><div style={{ fontSize: 18, fontWeight: 600 }}>{overview.lastFailureAt ? formatBeijingDateTime(String(overview.lastFailureAt)) : '—'}</div></div>
      </Space>
    </Card>
    <Card title="磁盘状态" size="small">
      <Space size="middle">
        <Tag color={disk.status === 'OK' ? 'green' : disk.status === 'WARN' ? 'orange' : 'red'}>{formatEnumLabel('diskStatus', disk.status)}</Tag>
        <Typography.Text>{disk.usageRatio === null || disk.usageRatio === undefined ? '使用率不可测' : `最高使用率 ${String(disk.usageRatio)}`}</Typography.Text>
      </Space>
    </Card>
    <Card title="按模块与任务类型" size="small" styles={{ body: { padding: 0 } }}>
      <Table<RecordValue> size="small" rowKey={(row) => `${String(row.module)}-${String(row.taskType)}`} pagination={false} dataSource={byModuleAndType} locale={{ emptyText: '暂无任务分组数据' }} scroll={{ x: 'max-content' }} columns={[
        { key: 'module', title: '模块', dataIndex: 'module', render: (value: unknown) => formatEnumLabel('backgroundTaskModule', value) },
        { key: 'taskType', title: '任务类型', dataIndex: 'taskType', render: (value: unknown) => formatEnumLabel('backgroundTaskType', value) },
        { key: 'pendingEnqueue', title: '待入队', dataIndex: 'pendingEnqueue', width: 90 },
        { key: 'queued', title: '排队中', dataIndex: 'queued', width: 90 },
        { key: 'running', title: '执行中', dataIndex: 'running', width: 90 },
        { key: 'failed24h', title: '近 24 小时失败', dataIndex: 'failed24h', width: 120 },
        { key: 'lastFailureAt', title: '最近失败时间', render: (value: unknown) => value ? formatBeijingDateTime(String(value)) : '—' },
      ]} />
    </Card>
  </Space>;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 将权限编辑器产出的授权列表规范化为后端 DTO。
 *
 * @param value 表单中的 grants/items 字段
 * @returns 合法的功能编码 + 数据范围列表
 * @throws 结构不合法时抛出可读错误
 */
function normalizeGrants(value: unknown): GrantItem[] {
  if (!Array.isArray(value)) {
    throw new Error('请通过权限选择器配置授权');
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.functionCode !== 'string' || !['SELF', 'DEPARTMENT', 'COMPANY'].includes(String(item.dataScope))) {
      throw new Error('授权明细不完整，请重新勾选功能与数据范围');
    }
    return { functionCode: item.functionCode, dataScope: item.dataScope as GrantItem['dataScope'] };
  });
}
