import { Button, Card, Drawer, Form, Input, InputNumber, Popconfirm, Segmented, Select, Space, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppShell, type NavigationItem } from '../../components/AppShell';
import { ApprovalCenter } from '../../components/ApprovalCenter';
import { DataTable, StatusTag } from '../../components/DataTable';
import { JsonDetails } from '../../components/JsonDetails';
import { ResourceFormModal } from '../../components/ResourceFormModal';
import { SystemHome } from '../../components/SystemHome';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import { useSession } from '../../request/session';

type RecordValue = Record<string, unknown>;

const NAVIGATION: NavigationItem[] = [
  { key: 'users', label: '用户管理', path: '/backstage/users', permission: 'user_manage' },
  { key: 'approval', label: '资料修改审批', path: '/backstage/approval', permission: 'user_manage' },
  { key: 'permissions', label: '功能权限', path: '/backstage/permissions', permission: 'permission_manage' },
  { key: 'groups', label: '权限组', path: '/backstage/permission-groups', permission: 'permission_manage' },
  { key: 'systems', label: '系统与业务结构', path: '/backstage/systems', permission: 'system_structure_manage' },
  { key: 'settings', label: '系统设置', path: '/backstage/settings', permission: 'system_settings' },
  { key: 'operations', label: '操作日志', path: '/backstage/operation-logs', permission: 'operation_log_view' },
  { key: 'system-logs', label: '系统日志', path: '/backstage/system-logs', permission: 'system_log_view' },
  { key: 'announcements', label: '系统公告', path: '/backstage/announcements', permission: 'announcement_manage' },
  { key: 'release-logs', label: '更新日志', path: '/backstage/release-logs', permission: 'release_log_view' },
  { key: 'backups', label: '数据备份与恢复', path: '/backstage/backups', permission: 'data_backup' },
  { key: 'health', label: '健康状态', path: '/backstage/health', permission: 'health_status' },
];

const USER_COLUMNS = [
  { key: 'id', title: '用户 ID', fixed: 'left' as const },
  { key: 'name', title: '姓名' },
  { key: 'phoneMasked', title: '手机号' },
  { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> },
  { key: 'isSuperAdmin', title: '超级管理员', render: (value: unknown) => (value === true ? '是' : '否') },
  { key: 'departments', title: '部门' },
  { key: 'grantsSummary', title: '授权摘要' },
];

const LIST_COLUMNS = [
  { key: 'id', title: 'ID', fixed: 'left' as const },
  { key: 'name', title: '名称' },
  { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> },
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
  { label: '同步手机号', value: 'PHONE_SYNCED' },
  { label: '手机号冲突', value: 'PHONE_SYNC_CONFLICT' },
  { label: '内部令牌失败', value: 'INTERNAL_TOKEN_FAILED' },
];

/** 管理后台路由容器。 */
export default function BackstagePage() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] ?? '';
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
      case 'systems':
        return <SystemStructure />;
      case 'settings':
        return <PlatformSettings />;
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
        return <JsonDetails title="健康状态" description="服务、依赖与后台任务汇总；不展示逐条任务明细。" service="platform" endpoint="/health-status" />;
      default:
        return <SystemHome systemName="管理后台" welcome="在这里管理平台用户、权限、系统配置与运维状态。" items={NAVIGATION} />;
    }
  }, [section]);
  return <AppShell systemName="管理后台" homePath="/backstage" items={NAVIGATION}>{body}</AppShell>;
}

function UserManagement() {
  const feedback = useFeedback();
  const { user } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
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
      const userIds = parseIdArray(values.userIds, '用户 ID');
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
        description="创建、维护、注销与恢复平台账号；批量注销采用全有或全无语义。"
        service="platform"
        endpoint="/users"
        pageKey="backstage-users"
        columns={USER_COLUMNS}
        filterFields={[
          { key: 'keyword', title: '姓名或手机号', type: 'text' },
          { key: 'status', title: '状态', type: 'enum', options: [{ label: '待激活', value: 'PENDING_ACTIVATION' }, { label: '正常', value: 'ACTIVE' }, { label: '已注销', value: 'DEACTIVATED' }] },
        ]}
        actions={<Space wrap><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>创建用户</Button><Button onClick={() => setRestoreOpen(true)}>恢复已注销用户</Button></Space>}
        onRowClick={(row) => setDetailId(Number(row.id))}
        batchAction={{ label: '批量注销', danger: true, onExecute: async (userIds) => { await http.post('/users/deactivations/batch', { userIds: userIds.map(Number) }); } }}
      />
      <ResourceFormModal title="创建用户" open={createOpen} onCancel={() => setCreateOpen(false)} onSubmit={create} fields={[
        { key: 'name', label: '姓名', required: true, maxLength: 50 },
        { key: 'phone', label: '手机号', required: true, maxLength: 32 },
        { key: 'gender', label: '性别', type: 'select', required: true, options: [{ label: '男', value: 'MALE' }, { label: '女', value: 'FEMALE' }] },
      ]} />
      <Drawer title="用户详情" open={detailId !== null} onClose={() => { setDetailId(null); setInvitationUrl(null); }} width={520}>
        {detail ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {Object.entries(detail).map(([key, value]) => <Card key={key} size="small" title={key}>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</Card>)}
            <Space wrap>
              <Button onClick={() => setEditing(true)}>编辑资料</Button>
              {detail.status === 'PENDING_ACTIVATION' ? <Button onClick={() => void issueActivation()}>生成激活邀请</Button> : null}
              {detail.status === 'ACTIVE' ? <Button onClick={() => void issueReset()}>生成密码重置邀请</Button> : null}
              <Button onClick={() => void unlock()}>解除登录锁定</Button>
              {user?.isSuperAdmin ? detail.isSuperAdmin === true
                ? <Popconfirm title="确认将该用户降级为普通员工？" onConfirm={() => void toggleSuperAdmin(false)}><Button danger>降级超管</Button></Popconfirm>
                : <Popconfirm title="确认任命该用户为超级管理员？" onConfirm={() => void toggleSuperAdmin(true)}><Button>任命超管</Button></Popconfirm>
                : null}
            </Space>
            {invitationUrl ? <Card size="small" title="一次性邀请链接"><Input readOnly value={invitationUrl} aria-label="一次性邀请链接" /><Typography.Paragraph type="warning" style={{ margin: '8px 0 0' }}>链接仅在当前抽屉中展示，请通过安全渠道转交，不要复制到长期记录。</Typography.Paragraph></Card> : null}
          </Space>
        ) : <Typography.Text>正在加载...</Typography.Text>}
      </Drawer>
      <ResourceFormModal title="编辑用户资料" open={editing} onCancel={() => setEditing(false)} onSubmit={update} initialValues={detail ?? {}} fields={[
        { key: 'name', label: '姓名', required: true, maxLength: 50 },
        { key: 'gender', label: '性别', type: 'select', required: true, options: [{ label: '男', value: 'MALE' }, { label: '女', value: 'FEMALE' }] },
      ]} />
      <ResourceFormModal title="恢复已注销用户" open={restoreOpen} onCancel={() => { setRestoreOpen(false); setRestorePreview(null); }} onSubmit={previewRestore} fields={[
        { key: 'userIds', label: '用户 ID（JSON 数组，最多 100 个）', type: 'textarea', required: true, placeholder: '[101,102]' },
      ]} submitText="生成恢复预览" />
      {restorePreview ? <Drawer title="恢复预览" open onClose={() => setRestorePreview(null)} width={640}>
        <Typography.Paragraph>仅“可恢复”的用户会在确认后恢复；服务端会再次校验版本、手机号和人事组织兼容性。</Typography.Paragraph>
        {Array.isArray(restorePreview.items) ? restorePreview.items.map((item, index) => <Card key={index} size="small" title={isRecord(item) ? String(item.name ?? item.userId ?? '用户') : '用户'} style={{ marginBottom: 12 }}>{isRecord(item) ? JSON.stringify(item) : String(item)}</Card>) : null}
        <Popconfirm title="确认恢复预览中全部可恢复用户？" onConfirm={() => void confirmRestore()}><Button type="primary">确认恢复</Button></Popconfirm>
      </Drawer> : null}
    </>
  );
}

function PermissionEmployees() {
  const feedback = useFeedback();
  const [selectedIds, setSelectedIds] = useState<Array<string | number>>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [grantDetail, setGrantDetail] = useState<RecordValue | null>(null);
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!targetId) {
      setGrantDetail(null);
      return;
    }
    void http.get<RecordValue>(`/permission/employees/${targetId}/grants`, { active: true })
      .then(setGrantDetail)
      .catch((error) => feedback.error(error, '员工授权加载失败'));
  }, [feedback, targetId]);

  const save = async (values: RecordValue) => {
    if (!targetId || !grantDetail || typeof grantDetail.permissionVersion !== 'number') return;
    try {
      await http.put(`/permission/employees/${targetId}/grants`, {
        permissionVersion: grantDetail.permissionVersion,
        grants: parseGrantItems(values.grants),
      });
      feedback.success('员工授权已保存');
      setEditing(false);
      setVersion((value) => value + 1);
      setGrantDetail(await http.get<RecordValue>(`/permission/employees/${targetId}/grants`, { active: true }));
    } catch (error) {
      feedback.error(error, '保存员工授权失败');
    }
  };
  const batchGrant = async (values: RecordValue) => {
    if (selectedIds.length === 0) return;
    try {
      await http.post('/permission/grants/batch', {
        userIds: selectedIds.map(Number),
        grants: parseGrantItems(values.grants),
        groupIds: parseIdArray(values.groupIds, '权限组 ID'),
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
      title="员工功能权限"
      description="点击员工维护完整授权；批量授权为追加，批量撤销会清除操作人可管理范围内的全部功能授权。"
      service="platform"
      endpoint="/permission/employees"
      pageKey="backstage-permission-employees"
      columns={USER_COLUMNS}
      filterFields={[{ key: 'keyword', title: '姓名或手机号', type: 'text' }]}
      onRowClick={(row) => setTargetId(Number(row.id))}
      onSelectionChange={setSelectedIds}
      actions={<Button disabled={selectedIds.length === 0} onClick={() => setBatchOpen(true)}>批量追加授权</Button>}
      batchAction={{ label: '批量撤销全部可管理授权', danger: true, onExecute: async (ids) => { await http.post('/permission/revocations/batch', { userIds: ids.map(Number) }); } }}
    />
    <Drawer title="员工授权" open={targetId !== null} onClose={() => setTargetId(null)} width={640}>
      {grantDetail ? <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card size="small" title="授权对象">{JSON.stringify(grantDetail.target ?? {})}</Card>
        <Card size="small" title={`当前授权（版本 ${String(grantDetail.permissionVersion ?? '—')}）`}>
          {Array.isArray(grantDetail.grants) && grantDetail.grants.length > 0 ? grantDetail.grants.map((grant, index) => <Typography.Paragraph key={index}>{isRecord(grant) ? `${String(grant.name ?? grant.functionCode)}（${String(grant.dataScope ?? '—')}）` : String(grant)}</Typography.Paragraph>) : <Typography.Text type="secondary">当前没有可见授权。</Typography.Text>}
        </Card>
        <Button type="primary" onClick={() => setEditing(true)}>修改权限</Button>
      </Space> : <Typography.Text>正在加载...</Typography.Text>}
    </Drawer>
    <ResourceFormModal title="修改员工权限" open={editing} onCancel={() => setEditing(false)} onSubmit={save} initialValues={{ grants: JSON.stringify(grantDetail?.grants ?? [], null, 2) }} fields={[
      { key: 'grants', label: '完整授权（JSON 数组）', type: 'textarea', required: true, maxLength: 10000, placeholder: '[{"functionCode":"fixed_asset_view","dataScope":"COMPANY"}]' },
    ]} />
    <ResourceFormModal title={`批量追加授权（${selectedIds.length} 人）`} open={batchOpen} onCancel={() => setBatchOpen(false)} onSubmit={batchGrant} initialValues={{ grants: '[]', groupIds: '[]' }} fields={[
      { key: 'grants', label: '直接授权（JSON 数组）', type: 'textarea', required: true, maxLength: 10000, placeholder: '[{"functionCode":"fixed_asset_view","dataScope":"COMPANY"}]' },
      { key: 'groupIds', label: '权限组 ID（JSON 数组，可空）', type: 'textarea', maxLength: 2000, placeholder: '[1,2]' },
    ]} />
  </>;
}

function PermissionGroups() {
  const feedback = useFeedback();
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
      await http.post('/permission/groups', { name: values.name, description: values.description, items: parseGrantItems(values.items) });
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
      await http.put(`/permission/groups/${groupId}`, { name: values.name, description: values.description, items: parseGrantItems(values.items) });
      feedback.success('权限组已更新');
      setEditing(false);
      setVersion((value) => value + 1);
      setGroup(await http.get<RecordValue>(`/permission/groups/${groupId}`, { active: true }));
    } catch (error) {
      feedback.error(error, '更新权限组失败');
    }
  };
  return <>
    <DataTable key={version} title="权限组" description="权限组作为可复用授权预设，授予员工时会展开为快照；后续修改不影响既有授权。" service="platform" endpoint="/permission/groups" pageKey="backstage-permission-groups" columns={[...LIST_COLUMNS, { key: 'itemCount', title: '功能数' }]} onRowClick={(row) => setGroupId(Number(row.id))} actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>创建权限组</Button>} batchAction={{ label: '删除权限组', danger: true, onExecute: async (groupIds) => { await http.post('/permission/groups/batch-delete', { groupIds: groupIds.map(Number) }); } }} />
    <ResourceFormModal title="创建权限组" open={open} onCancel={() => setOpen(false)} onSubmit={create} initialValues={{ items: '[]' }} fields={[{ key: 'name', label: '名称', required: true, maxLength: 50 }, { key: 'description', label: '说明', type: 'textarea', maxLength: 500 }, { key: 'items', label: '授权明细（JSON 数组）', type: 'textarea', required: true, maxLength: 10000, placeholder: '[{"functionCode":"fixed_asset_view","dataScope":"COMPANY"}]' }]} />
    <Drawer title="权限组详情" open={groupId !== null} onClose={() => setGroupId(null)} width={640}>
      {group ? <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card size="small" title="基本信息">名称：{String(group.name ?? '—')}；说明：{String(group.description ?? '—')}</Card>
        <Card size="small" title="授权明细">{Array.isArray(group.items) && group.items.length > 0 ? group.items.map((item, index) => <Typography.Paragraph key={index}>{isRecord(item) ? `${String(item.name ?? item.functionCode)}（${String(item.dataScope ?? '—')}）${item.valid === false ? '，已失效' : ''}` : String(item)}</Typography.Paragraph>) : <Typography.Text type="secondary">当前是空权限组。</Typography.Text>}</Card>
        <Button type="primary" onClick={() => setEditing(true)}>编辑权限组</Button>
      </Space> : <Typography.Text>正在加载...</Typography.Text>}
    </Drawer>
    <ResourceFormModal title="编辑权限组" open={editing} onCancel={() => setEditing(false)} onSubmit={update} initialValues={{ name: group?.name, description: group?.description, items: JSON.stringify(group?.items ?? [], null, 2) }} fields={[{ key: 'name', label: '名称', required: true, maxLength: 50 }, { key: 'description', label: '说明', type: 'textarea', maxLength: 500 }, { key: 'items', label: '授权明细（JSON 数组）', type: 'textarea', required: true, maxLength: 10000 }]} />
  </>;
}

function SystemStructure() {
  const feedback = useFeedback();
  const [systems, setSystems] = useState<StructureSystem[]>([]);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try {
      const result = await http.get<{ systems?: StructureSystem[] }>('/systems', { active: true });
      setSystems(result.systems ?? []);
    } catch (error) {
      feedback.error(error, '系统结构加载失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []); // 仅首次加载；保存后直接刷新结构快照。
  const update = async (path: string, body: Record<string, unknown>, message: string) => {
    try {
      await http.put(path, body);
      feedback.success(message);
      await load();
    } catch (error) {
      feedback.error(error, `${message}失败`);
    }
  };
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <div><Typography.Title level={3}>系统与业务结构</Typography.Title><Typography.Paragraph type="secondary">目录的归属与排序由代码注册表维护；此处可调整业务系统开放状态，并维护板块和功能说明。</Typography.Paragraph></div>
    {systems.map((system) => <Card key={system.code} loading={loading} title={system.name} extra={<Space><Typography.Text type="secondary">{system.code}</Typography.Text><Select value={system.productStatus} style={{ width: 140 }} disabled={system.code === 'BACKSTAGE'} options={[{ label: '开放', value: 'OPEN' }, { label: '即将上线', value: 'COMING_SOON' }]} onChange={(productStatus: 'OPEN' | 'COMING_SOON') => void update(`/systems/${system.code}/status`, { productStatus }, '系统状态已更新')} /></Space>}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {system.sections.map((section) => <Card key={section.code} size="small" title={section.name} extra={<Typography.Text type="secondary">{section.code}</Typography.Text>}>
          <Input.TextArea defaultValue={section.description ?? ''} rows={2} maxLength={500} placeholder="板块说明（留空并失焦即可清除）" onBlur={(event) => { if (event.currentTarget.value !== (section.description ?? '')) void update(`/systems/${system.code}/sections/${section.code}/description`, { description: event.currentTarget.value }, '板块说明已更新'); }} />
          <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 12 }}>
            {section.functions.map((fn) => <Card key={fn.code} size="small" title={fn.name} extra={<Typography.Text type="secondary">{fn.code}</Typography.Text>}>
              <Typography.Text type="secondary">数据范围：{fn.dataScopeOptions.join(' / ') || '—'}</Typography.Text>
              <Input.TextArea defaultValue={fn.description ?? ''} rows={2} maxLength={500} placeholder="功能说明（留空并失焦即可清除）" onBlur={(event) => { if (event.currentTarget.value !== (fn.description ?? '')) void update(`/systems/functions/${fn.code}/description`, { description: event.currentTarget.value }, '功能说明已更新'); }} />
            </Card>)}
          </Space>
        </Card>)}
      </Space>
    </Card>)}
  </Space>;
}

interface StructureFunction { code: string; name: string; description: string | null; dataScopeOptions: string[]; }
interface StructureSection { code: string; name: string; description: string | null; functions: StructureFunction[]; }
interface StructureSystem { code: string; name: string; productStatus: 'OPEN' | 'COMING_SOON'; sections: StructureSection[]; }

function PlatformSettings() {
  const feedback = useFeedback();
  const [settings, setSettings] = useState<Array<{ key: string; label: string; value: number; min: number; max: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [form] = Form.useForm<Record<string, number>>();
  useEffect(() => {
    void http.get<{ settings: Array<{ key: string; label: string; value: number; min: number; max: number }> }>('/system-settings', { active: true }).then((result) => { setSettings(result.settings); form.setFieldsValue(Object.fromEntries(result.settings.map((item) => [item.key, item.value]))); }).catch((error) => feedback.error(error, '系统设置加载失败')).finally(() => setLoading(false));
  }, [feedback, form]);
  const save = async (values: Record<string, number>) => {
    await http.put('/system-settings', { patches: values });
    feedback.success('系统设置已保存并即时生效');
  };
  return <>
    <Typography.Title level={3}>系统设置</Typography.Title>
    <Typography.Paragraph type="secondary">设置仅影响之后开始的业务操作；固定安全常量不在此处开放。</Typography.Paragraph>
    <Card loading={loading}>
      <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
        {settings.map((setting) => <Form.Item key={setting.key} name={setting.key} label={setting.label} rules={[{ required: true }]}><InputNumber min={setting.min} max={setting.max} style={{ width: '100%' }} /></Form.Item>)}
        <Button type="primary" htmlType="submit">保存设置</Button>
      </Form>
    </Card>
  </>;
}

function OperationLogs() {
  return <DataTable title="操作日志" description="全站只追加审计记录；导出包含当前用户数据范围内的全部记录。" service="platform" endpoint="/operation-logs" pageKey="backstage-operation-logs" columns={[...LIST_COLUMNS, { key: 'operatorName', title: '操作者' }, { key: 'actionType', title: '操作', render: (value: unknown) => <StatusTag value={value} /> }, { key: 'summary', title: '摘要' }]} filterFields={[{ key: 'system', title: '系统', type: 'enum', options: OPERATION_SYSTEM_OPTIONS }, { key: 'operatorId', title: '操作者', type: 'number' }, { key: 'actionType', title: '操作', type: 'enum', options: [{ label: '新增', value: 'CREATE' }, { label: '修改', value: 'UPDATE' }, { label: '删除', value: 'DELETE' }, { label: '导出', value: 'EXPORT' }] }]} exportConfig={{ allEndpoint: '/operation-logs/export', filename: 'operation-logs.xlsx', method: 'POST' }} />;
}

function SystemLogs() {
  const feedback = useFeedback();
  const [tab, setTab] = useState<'errors' | 'security'>('errors');
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
    <Segmented value={tab} onChange={(value) => setTab(value as 'errors' | 'security')} options={[{ label: '错误日志', value: 'errors' }, { label: '安全日志', value: 'security' }]} />
    {tab === 'errors' ? <DataTable key={`errors-${version}`} title="错误日志" description="重要运行异常按指纹聚合；处置后不可回退，点击行可查看脱敏详情。" service="platform" endpoint="/system-logs/errors" pageKey="backstage-error-logs" columns={[...LIST_COLUMNS, { key: 'level', title: '级别' }, { key: 'service', title: '服务' }, { key: 'occurrenceCount', title: '发生次数' }, { key: 'lastSeenAt', title: '最近发生' }]} filterFields={[{ key: 'service', title: '服务', type: 'text' }, { key: 'status', title: '状态', type: 'enum', options: [{ label: '待处理', value: 'PENDING' }, { label: '已处理', value: 'HANDLED' }, { label: '已忽略', value: 'IGNORED' }] }]} onRowClick={(row) => setDetailId(Number(row.id))} exportConfig={{ allEndpoint: '/system-logs/errors/export', filename: 'errors-logs.xlsx', method: 'POST' }} rowActions={(row) => row.status === 'PENDING' ? <Space size="small"><Popconfirm title="确认标记为已处理？" onConfirm={() => void dispose(Number(row.id), 'HANDLED')}><Button size="small">已处理</Button></Popconfirm><Popconfirm title="确认忽略此错误？" onConfirm={() => void dispose(Number(row.id), 'IGNORED')}><Button size="small" danger>忽略</Button></Popconfirm></Space> : null} /> : <DataTable title="安全日志" description="认证与账号安全事件只读追加；导出会遵守日志脱敏白名单。" service="platform" endpoint="/system-logs/security" pageKey="backstage-security-logs" columns={[...LIST_COLUMNS, { key: 'eventType', title: '事件' }, { key: 'actorId', title: '操作者 ID' }, { key: 'targetUserId', title: '目标用户 ID' }, { key: 'result', title: '结果', render: (value: unknown) => <StatusTag value={value} /> }]} filterFields={[{ key: 'eventType', title: '事件类型', type: 'enum', options: SECURITY_EVENT_TYPE_OPTIONS }, { key: 'actorId', title: '操作者 ID', type: 'number' }, { key: 'targetUserId', title: '目标用户 ID', type: 'number' }, { key: 'result', title: '结果', type: 'enum', options: [{ label: '成功', value: 'SUCCESS' }, { label: '失败', value: 'FAILURE' }] }]} exportConfig={{ allEndpoint: '/system-logs/security/export', filename: 'security-logs.xlsx', method: 'POST' }} />}
    <Drawer title="错误日志详情" open={detailId !== null} onClose={() => setDetailId(null)} width={620}>{detail ? Object.entries(detail).map(([key, value]) => <Card key={key} size="small" title={key} style={{ marginBottom: 8 }}>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</Card>) : <Typography.Text>正在加载...</Typography.Text>}</Drawer>
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
    <DataTable key={version} title="系统公告" description="同一时刻仅一条公告处于展示状态；发布、撤回与删除均需要确认。" service="platform" endpoint="/announcements" pageKey="backstage-announcements" columns={[...LIST_COLUMNS, { key: 'title', title: '标题' }, { key: 'publishedAt', title: '发布时间' }]} filterFields={[{ key: 'status', title: '状态', type: 'enum', options: [{ label: '草稿', value: 'DRAFT' }, { label: '展示中', value: 'PUBLISHING' }, { label: '已撤回', value: 'REVOKED' }] }]} actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建公告</Button>} batchAction={{ label: '删除公告', danger: true, onExecute: async (ids) => { await http.delete('/announcements/batch', { ids: ids.map(Number) }); setVersion((value) => value + 1); } }} rowActions={(row) => <Space size="small"><Popconfirm title="确认发布此公告？" onConfirm={() => void changeStatus(Number(row.id), 'publish')}><Button size="small">发布</Button></Popconfirm><Popconfirm title="确认撤回此公告？" onConfirm={() => void changeStatus(Number(row.id), 'revoke')}><Button size="small" danger>撤回</Button></Popconfirm></Space>} />
    <ResourceFormModal title="新建公告" open={open} onCancel={() => setOpen(false)} onSubmit={async (values) => { await http.post('/announcements', values); feedback.success('公告草稿已创建'); setOpen(false); setVersion((value) => value + 1); }} fields={[{ key: 'title', label: '标题', required: true, maxLength: 200 }, { key: 'content', label: '内容', type: 'textarea', maxLength: 10000 }]} />
  </>;
}

function ReleaseLogs() {
  return <DataTable title="更新日志" description="展示成功发布生成的平台更新记录。" service="platform" endpoint="/release-logs" pageKey="backstage-release-logs" columns={[...LIST_COLUMNS, { key: 'version', title: '版本' }, { key: 'subjects', title: '内容' }]} />;
}

function Backups() {
  const feedback = useFeedback();
  const { user } = useSession();
  const [version, setVersion] = useState(0);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [precheck, setPrecheck] = useState<RecordValue | null>(null);
  const submitPrecheck = async (values: RecordValue) => {
    try {
      const backupId = Number(values.backupId);
      const result = await http.post<RecordValue>('/restores/precheck', { backupId });
      setPrecheck({ ...result, backupId });
      setRestoreOpen(false);
    } catch (error) {
      feedback.error(error, '恢复预检失败');
    }
  };
  const confirmRestore = async (values: RecordValue) => {
    if (!precheck || typeof precheck.backupId !== 'number') return;
    try {
      await http.post('/restores/confirm', { backupId: precheck.backupId, note: values.note, proceedWithoutEmergency: values.proceedWithoutEmergency === true });
      feedback.success('恢复任务已确认，系统将先执行紧急备份');
      setPrecheck(null);
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
    <DataTable key={`backups-${version}`} title="数据备份" description="立即备份由后台任务执行；恢复前必须先完成服务端预检。" service="platform" endpoint="/backups" pageKey="backstage-backups" columns={[...LIST_COLUMNS, { key: 'type', title: '类型' }, { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> }, { key: 'completedAt', title: '完成时间' }]} actions={<Space><Button icon={<ReloadOutlined />} onClick={() => void immediateBackup()}>立即备份</Button>{user?.isSuperAdmin ? <Button danger onClick={() => setRestoreOpen(true)}>恢复预检</Button> : null}</Space>} />
    <DataTable key={`restores-${version}`} title="恢复记录" description="恢复过程会保持维护状态；失败后需要在恢复控制会话中人工处理。" service="platform" endpoint="/restores" pageKey="backstage-restores" columns={[...LIST_COLUMNS, { key: 'backupId', title: '来源备份' }, { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> }, { key: 'createdAt', title: '发起时间' }]} />
    <ResourceFormModal title="恢复预检" open={restoreOpen} onCancel={() => setRestoreOpen(false)} onSubmit={submitPrecheck} fields={[{ key: 'backupId', label: '待恢复备份 ID', type: 'number', required: true }]} submitText="执行预检" />
    {precheck ? <Drawer title="恢复预检结果" open onClose={() => setPrecheck(null)} width={620}><Typography.Paragraph type="warning">恢复会覆盖当前数据库。确认后服务端会先创建紧急备份；紧急备份失败时只有明确勾选风险确认才能继续。</Typography.Paragraph>{Object.entries(precheck).map(([key, value]) => <Card key={key} size="small" title={key} style={{ marginBottom: 8 }}>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</Card>)}<ResourceFormModal title="确认数据库恢复" open onCancel={() => setPrecheck(null)} onSubmit={confirmRestore} fields={[{ key: 'note', label: '恢复说明', type: 'textarea', maxLength: 500 }, { key: 'proceedWithoutEmergency', label: '紧急备份失败时，已人工确认风险并继续', type: 'boolean' }]} submitText="确认恢复" /></Drawer> : null}
  </Space>;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonArray(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') throw new Error(`${label}必须是 JSON 数组`);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 数组`);
    return parsed;
  } catch {
    throw new Error(`${label} JSON 格式不正确`);
  }
}

function parseIdArray(value: unknown, label: string): number[] {
  const items = parseJsonArray(value, label);
  if (!items.every((item) => typeof item === 'number' && Number.isInteger(item) && item > 0)) throw new Error(`${label}必须是正整数数组`);
  return items as number[];
}

function parseGrantItems(value: unknown): Array<{ functionCode: string; dataScope: 'SELF' | 'DEPARTMENT' | 'COMPANY' }> {
  const items = parseJsonArray(value, '授权明细');
  const result = items.map((item) => {
    if (!isRecord(item) || typeof item.functionCode !== 'string' || !['SELF', 'DEPARTMENT', 'COMPANY'].includes(String(item.dataScope))) {
      throw new Error('授权明细必须包含 functionCode 与合法 dataScope');
    }
    return { functionCode: item.functionCode, dataScope: item.dataScope as 'SELF' | 'DEPARTMENT' | 'COMPANY' };
  });
  return result;
}
