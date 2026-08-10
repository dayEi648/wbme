import { Button, Card, Popconfirm, Segmented, Space, Table, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppShell, type NavigationItem } from '../../components/AppShell';
import { ApprovalCenter } from '../../components/ApprovalCenter';
import { DataTable, StatusTag } from '../../components/DataTable';
import { ResourcePage } from '../../components/ResourcePage';
import { ResourceFormModal } from '../../components/ResourceFormModal';
import { SettingsEditor } from '../../components/SettingsEditor';
import { SystemHome } from '../../components/SystemHome';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import { useSession } from '../../request/session';

const NAVIGATION: NavigationItem[] = [
  { key: 'my-assets', label: '我的资产', path: '/asset/my-assets', permission: 'my_assets' },
  { key: 'assets', label: '固定资产台账', path: '/asset/assets', permission: ['fixed_asset_view', 'fixed_asset_maintain'] },
  { key: 'repairs', label: '维修管理', path: '/asset/repairs', permission: 'fixed_asset_maintain' },
  { key: 'consumables', label: '消耗品配置', path: '/asset/consumables', permission: 'inventory_manage' },
  { key: 'warehouses', label: '库位管理', path: '/asset/warehouses', permission: 'inventory_manage' },
  { key: 'inventory', label: '库存管理', path: '/asset/inventory', permission: 'inventory_manage' },
  { key: 'stock-flows', label: '库存流水', path: '/asset/stock-flows', permission: 'inventory_manage' },
  { key: 'transfers', label: '库存调拨', path: '/asset/transfers', permission: 'inventory_manage' },
  { key: 'stock-in', label: '入库申请', path: '/asset/stock-in', permission: 'stock_in_apply' },
  { key: 'stock-change', label: '库存变更申请', path: '/asset/stock-change', permission: 'stock_change_apply' },
  { key: 'claims', label: '消耗品申领', path: '/asset/claims', permission: 'consumable_apply' },
  { key: 'stock-in-history', label: '入库申请历史', path: '/asset/stock-in-history', permission: 'stock_in_history' },
  { key: 'stock-change-history', label: '库存变更历史', path: '/asset/stock-change-history', permission: 'stock_change_history' },
  { key: 'claim-history', label: '申领历史', path: '/asset/claim-history', permission: 'consumable_apply_history' },
  { key: 'borrow-history', label: '借还历史', path: '/asset/borrow-history', permission: 'borrow_history' },
  { key: 'agent-claims', label: '代领申请', path: '/asset/agent-claims', permission: 'proxy_apply' },
  { key: 'agent-settlements', label: '代领结清', path: '/asset/agent-settlements', permission: 'proxy_apply' },
  { key: 'borrow', label: '借还与核销', path: '/asset/borrow', permission: 'my_borrow' },
  { key: 'my-requests', label: '我的资产申请', path: '/asset/my-requests', permission: ['stock_in_apply', 'stock_change_apply', 'consumable_apply', 'proxy_apply', 'my_borrow'] },
  { key: 'disposals', label: '注销处置', path: '/asset/disposals', permission: 'consumable_approval' },
  { key: 'qr-codes', label: '二维码管理', path: '/asset/qr-codes', permission: ['fixed_asset_maintain', 'inventory_manage'] },
  { key: 'approval', label: '审批中心', path: '/asset/approval', permission: 'consumable_approval' },
  { key: 'config', label: '资产配置', path: '/asset/config', permission: 'asset_config' },
];

const ASSET_COLUMNS = [
  { key: 'id', title: 'ID', fixed: 'left' as const },
  { key: 'name', title: '资产名称' },
  { key: 'categoryName', title: '分类' },
  { key: 'departmentName', title: '所属部门' },
  { key: 'usageStatus', title: '状态', render: (value: unknown) => <StatusTag value={value} /> },
  { key: 'responsibleUserName', title: '责任人' },
  { key: 'updatedAt', title: '更新时间' },
];

const COMMON_COLUMNS = [
  { key: 'id', title: 'ID', fixed: 'left' as const },
  { key: 'name', title: '名称' },
  { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> },
  { key: 'createdAt', title: '创建时间' },
];

/** 审批申请列表列（契约：对齐后端 ApprovalRequest 模型字段——无 name，申请人见 applicantName 列；M20 复核修复） */
const REQUEST_COLUMNS = [
  { key: 'id', title: 'ID', fixed: 'left' as const },
  { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> },
  { key: 'submittedAt', title: '提交时间' },
];

/**
 * 借还历史列（契约：对齐后端 borrow.service listHistory SELECT 字段经 DataTable
 * normalizeRow 转驼峰后的键，asset-page-columns.spec 有列 key 契约断言，M20）。
 */
export const BORROW_HISTORY_COLUMNS = [
  { key: 'id', title: 'ID', fixed: 'left' as const },
  { key: 'recordType', title: '记录类型' },
  { key: 'userName', title: '借用人/代交人' },
  { key: 'consumableName', title: '物品' },
  { key: 'qty', title: '数量' },
  { key: 'borrowedAt', title: '借出时间' },
  { key: 'dueAt', title: '到期时间' },
  { key: 'returnedQty', title: '已归还' },
  { key: 'writtenOffQty', title: '已核销' },
  { key: 'createdAt', title: '创建时间' },
];

/** 待处置列（契约：对齐后端 disposal.service listPending SELECT 字段经 normalizeRow 转驼峰，M28） */
export const DISPOSAL_PENDING_COLUMNS = [
  { key: 'recordId', title: '记录 ID', fixed: 'left' as const },
  { key: 'recordType', title: '记录类型' },
  { key: 'userName', title: '目标用户' },
  { key: 'consumableName', title: '物品' },
  { key: 'qty', title: '数量' },
  { key: 'dueAt', title: '到期时间' },
];

/** 处置记录列（契约：对齐后端 disposal.service listRecords SELECT 字段，M28） */
export const DISPOSAL_RECORDS_COLUMNS = [
  { key: 'id', title: 'ID', fixed: 'left' as const },
  { key: 'recordType', title: '记录类型' },
  { key: 'userName', title: '目标用户' },
  { key: 'consumableName', title: '物品' },
  { key: 'qty', title: '数量' },
  { key: 'disposalType', title: '处置方式' },
  { key: 'processorName', title: '处理人' },
  { key: 'createdAt', title: '处理时间' },
];

const ENABLED_STATUS_OPTIONS = [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }];
const APPROVAL_STATUS_OPTIONS = [{ label: '待审批', value: 'PENDING' }, { label: '已批准', value: 'APPROVED' }, { label: '已驳回', value: 'REJECTED' }, { label: '已取消', value: 'CANCELLED' }];
const ASSET_USAGE_STATUS_OPTIONS = [{ label: '闲置', value: 'IDLE' }, { label: '使用中', value: 'IN_USE' }, { label: '待维修', value: 'PENDING_REPAIR' }, { label: '维修中', value: 'REPAIRING' }, { label: '已报废', value: 'SCRAPPED' }];

/** 资产系统路由容器。 */
export default function AssetPage() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] ?? '';
  const body = useMemo(() => {
    switch (section) {
      case 'my-assets':
        return <DataTable title="我的资产" description="查看本人负责、使用或相关的固定资产。" service="asset" endpoint="/assets/mine" pageKey="asset-my-assets" columns={ASSET_COLUMNS} filterFields={[{ key: 'scope', title: '范围', type: 'enum', options: [{ label: '负责', value: 'OWNED' }, { label: '使用', value: 'USED' }, { label: '全部', value: 'ALL' }] }]} />;
      case 'assets':
        return <FixedAssets />;
      case 'repairs':
        return <RepairManagement />;
      case 'consumables':
        return <ResourcePage title="消耗品配置" description="维护可申领的消耗品品种、单位及启停状态。" service="asset" endpoint="/consumables" pageKey="asset-consumables" columns={[...COMMON_COLUMNS, { key: 'unitName', title: '单位' }, { key: 'categoryName', title: '分类' }]} filterFields={[{ key: 'keyword', title: '关键字', type: 'text' }, { key: 'status', title: '状态', type: 'enum', options: ENABLED_STATUS_OPTIONS }]} create={{ title: '新建消耗品', endpoint: '/consumables', fields: [{ key: 'name', label: '名称', required: true, maxLength: 50 }, { key: 'type', label: '品种类型', type: 'select', required: true, options: [{ label: '一次性用品', value: 'DISPOSABLE' }, { label: '借还用品', value: 'REUSABLE' }] }, { key: 'unitId', label: '单位 ID', type: 'number' }, { key: 'categoryId', label: '分类 ID', type: 'number' }, { key: 'quotaCycle', label: '一次性用品周期', type: 'select', options: [{ label: '月', value: 'MONTH' }, { label: '季度', value: 'QUARTER' }, { label: '年', value: 'YEAR' }] }, { key: 'quotaLimit', label: '一次性用品数量上限', type: 'number' }, { key: 'returnDays', label: '借还期限（天）', type: 'number' }, { key: 'maxHolding', label: '借还同时持有上限', type: 'number' }, { key: 'referencePrice', label: '参考单价', type: 'number' }, { key: 'safetyStock', label: '安全库存', type: 'number' }] }} edit={{ title: '编辑消耗品', fields: [{ key: 'name', label: '名称', required: true, maxLength: 50 }, { key: 'type', label: '品种类型', type: 'select', required: true, options: [{ label: '一次性用品', value: 'DISPOSABLE' }, { label: '借还用品', value: 'REUSABLE' }] }, { key: 'categoryId', label: '分类 ID', type: 'number' }, { key: 'quotaCycle', label: '一次性用品周期', type: 'select', options: [{ label: '月', value: 'MONTH' }, { label: '季度', value: 'QUARTER' }, { label: '年', value: 'YEAR' }] }, { key: 'quotaLimit', label: '一次性用品数量上限', type: 'number' }, { key: 'returnDays', label: '借还期限（天）', type: 'number' }, { key: 'maxHolding', label: '借还同时持有上限', type: 'number' }, { key: 'referencePrice', label: '参考单价', type: 'number' }, { key: 'safetyStock', label: '安全库存', type: 'number', required: true }, { key: 'status', label: '状态', type: 'select', required: true, options: ENABLED_STATUS_OPTIONS }] }} batchDelete={{ endpoint: '/consumables/batch', bodyKey: 'ids' }} />;
      case 'warehouses':
        return <ResourcePage title="库位管理" description="维护全公司统一层级库位树；移动或删除前由服务端校验循环和业务引用。" service="asset" endpoint="/warehouses/tree" pageKey="asset-warehouses" columns={[...COMMON_COLUMNS, { key: 'parentName', title: '上级库位' }, { key: 'sort', title: '排序' }]} filterFields={[{ key: 'status', title: '状态', type: 'enum', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }]} create={{ title: '新建库位', endpoint: '/warehouses', fields: [{ key: 'name', label: '库位名称', required: true, maxLength: 50 }, { key: 'parentId', label: '上级库位 ID', type: 'number' }, { key: 'sort', label: '排序', type: 'number' }] }} edit={{ title: '编辑库位', endpoint: (id) => `/warehouses/${id}`, fields: [{ key: 'name', label: '库位名称', required: true, maxLength: 50 }, { key: 'parentId', label: '上级库位 ID', type: 'number' }, { key: 'sort', label: '排序', type: 'number' }, { key: 'status', label: '状态', type: 'select', required: true, options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }] }} batchDelete={{ endpoint: '/warehouses/batch', bodyKey: 'ids' }} />;
      case 'inventory':
        return <InventoryManagement />;
      case 'stock-flows':
        return <StockFlows />;
      case 'transfers':
        return <ResourcePage title="库存调拨" description="每次调拨处理一个库存条目，服务端按 FIFO 分配批次并保持总量不变。" service="asset" endpoint="/asset/inventory-transfers" pageKey="asset-inventory-transfers" columns={[...COMMON_COLUMNS, { key: 'sourceLocationName', title: '来源库位' }, { key: 'targetLocationName', title: '目标库位' }, { key: 'qty', title: '数量' }]} create={{ title: '发起调拨', fields: [{ key: 'fromInventoryItemId', label: '来源库存 ID', type: 'number', required: true }, { key: 'toWarehouseId', label: '目标库位 ID', type: 'number', required: true }, { key: 'qty', label: '数量', type: 'number', required: true }, { key: 'remark', label: '备注', type: 'textarea', maxLength: 200 }] }} />;
      case 'stock-in':
        return <ResourcePage title="入库申请" description="提交后库存按审批状态占用或入账；展示本人提交的历史。" service="asset" endpoint="/stock-in-requests/mine" pageKey="asset-stock-in" columns={[...REQUEST_COLUMNS, { key: 'applicantName', title: '申请人' }]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]} create={{ title: '新建入库申请', endpoint: '/stock-in-requests', fields: [{ key: 'items', label: '入库明细（JSON）', type: 'textarea', required: true, maxLength: 10000 }], transform: (values) => ({ ...values, items: parseJsonArray(values.items) }) }} />;
      case 'stock-in-history':
        return <ResourcePage title="入库申请历史" description="查看数据范围内全部入库申请记录（「入库申请历史记录」部门/公司档）。" service="asset" endpoint="/stock-in-requests" pageKey="asset-stock-in-history" columns={[...REQUEST_COLUMNS, { key: 'applicantName', title: '申请人' }]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }, { key: 'applicantName', title: '发起人姓名', type: 'text' }]} />;
      case 'stock-change':
        return <ResourcePage title="库存变更申请" description="意外扣减等库存变更经过审批，拒绝与取消会释放占用。" service="asset" endpoint="/stock-change-requests/mine" pageKey="asset-stock-change" columns={[...REQUEST_COLUMNS, { key: 'applicantName', title: '申请人' }]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]} create={{ title: '新建库存变更申请', endpoint: '/stock-change-requests', fields: [{ key: 'items', label: '变更明细（JSON）', type: 'textarea', required: true, maxLength: 10000 }], transform: (values) => ({ ...values, items: parseJsonArray(values.items) }) }} />;
      case 'stock-change-history':
        return <ResourcePage title="库存变更历史" description="查看数据范围内全部库存变更申请记录（「库存变更申请历史记录」部门/公司档）。" service="asset" endpoint="/stock-change-requests" pageKey="asset-stock-change-history" columns={[...REQUEST_COLUMNS, { key: 'applicantName', title: '申请人' }]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }, { key: 'applicantName', title: '发起人姓名', type: 'text' }]} />;
      case 'claims':
        return <ResourcePage title="消耗品申领" description="普通申领按可用库存与个人额度进行原子占用。" service="asset" endpoint="/consumable-requests/mine" pageKey="asset-claims" columns={[...REQUEST_COLUMNS, { key: 'applicantName', title: '申请人' }]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]} create={{ title: '提交申领', endpoint: '/consumable-requests', fields: [{ key: 'items', label: '申领明细（JSON）', type: 'textarea', required: true, maxLength: 10000 }], transform: (values) => ({ ...values, items: parseJsonArray(values.items) }) }} />;
      case 'claim-history':
        return <ResourcePage title="申领历史" description="查看数据范围内全部消耗品申领记录（「消耗品申领历史记录」部门/公司档）。" service="asset" endpoint="/consumable-requests" pageKey="asset-claim-history" columns={[...REQUEST_COLUMNS, { key: 'applicantName', title: '申请人' }]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }, { key: 'applicantName', title: '发起人姓名', type: 'text' }]} />;
      case 'agent-claims':
        return <ResourcePage title="代领申请" description="代领需指定受领人；受领人可查看共享借还清单。" service="asset" endpoint="/agent-requests/mine" pageKey="asset-agent-claims" columns={[...REQUEST_COLUMNS, { key: 'applicantName', title: '代领人' }, { key: 'recipientCount', title: '受领人数' }]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]} create={{ title: '提交代领申请', endpoint: '/agent-requests', fields: [{ key: 'items', label: '物品明细（JSON）', type: 'textarea', required: true, maxLength: 10000 }, { key: 'recipientIds', label: '受领人 ID（JSON 数组）', type: 'textarea', required: true, maxLength: 2000 }], transform: (values) => ({ ...values, items: parseJsonArray(values.items), recipientIds: parseJsonArray(values.recipientIds) }) }} />;
      case 'agent-settlements':
        return <ResourcePage title="代领整单结清" description="代领借还必须一次性覆盖整张共享清单的全部未结清数量，提交后进入消耗品审批。" service="asset" endpoint="/agent-settlements/mine" pageKey="asset-agent-settlements" columns={[...REQUEST_COLUMNS, { key: 'applicationNo', title: '申请编号' }]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]} create={{ title: '提交代领整单结清', endpoint: '/agent-settlements', fields: [{ key: 'refRequestId', label: '代领申请 ID', type: 'number', required: true }, { key: 'items', label: '结清明细（JSON）', type: 'textarea', required: true, maxLength: 10000, placeholder: '[{"borrowRecordId":1,"method":"RETURN","qty":1}]' }], transform: (values) => ({ refRequestId: values.refRequestId, items: parseJsonArray(values.items) }) }} />;
      case 'borrow':
        return <BorrowPage />;
      case 'borrow-history':
        return <ResourcePage title="借还历史" description="查看数据范围内全部借还/归还/核销记录（「借还历史记录」部门/公司档）。" service="asset" endpoint="/borrow-records" pageKey="asset-borrow-history" columns={BORROW_HISTORY_COLUMNS} filterFields={[{ key: 'keyword', title: '物品/借用人关键字', type: 'text' }]} />;
      case 'my-requests':
        return <MyAssetApplications />;
      case 'disposals':
        return <DisposalManagement />;
      case 'qr-codes':
        return <QrCodeManagement />;
      case 'approval':
        return <ApprovalPage />;
      case 'config':
        return <AssetConfig />;
      default:
        return <SystemHome systemName="资产系统" welcome="办理资产台账、消耗品库存、申领审批与资产配置。" items={NAVIGATION} />;
    }
  }, [section]);
  return <AppShell systemName="资产系统" homePath="/asset" items={NAVIGATION}>{body}</AppShell>;
}

function FixedAssets() {
  const feedback = useFeedback();
  const { can } = useSession();
  // 只读用户（fixed_asset_view）不展示任何编辑入口（主 PRD §10.4，M25）
  const canMaintain = can('fixed_asset_maintain');
  const [version, setVersion] = useState(0);
  const [scheduleId, setScheduleId] = useState<number | null>(null);
  const schedule = async (values: Record<string, unknown>) => {
    if (!scheduleId) return;
    try {
      await http.post(`/assets/${scheduleId}/schedule`, values, { service: 'asset' });
      feedback.success('资产调度已完成');
      setScheduleId(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '资产调度失败');
    }
  };
  const scrap = async (id: number) => {
    try {
      await http.post(`/assets/${id}/scrap`, { confirm: true }, { service: 'asset' });
      feedback.success('资产已报废');
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '资产报废失败');
    }
  };
  return <>
    <ResourcePage
      key={version}
      title="固定资产台账"
      description="维护资产资料、调度、报废和维修状态；点击资产可编辑基础资料，部门和责任人变更必须走调度记录。"
      service="asset"
      endpoint="/assets"
      pageKey="asset-ledger"
      columns={ASSET_COLUMNS}
      filterFields={[
        { key: 'keyword', title: '关键字', type: 'text' },
        { key: 'usageStatus', title: '状态', type: 'enum', options: ASSET_USAGE_STATUS_OPTIONS },
        { key: 'departmentId', title: '部门 ID', type: 'number' },
      ]}
      create={canMaintain ? {
        title: '新建固定资产',
        fields: [
          { key: 'name', label: '资产名称', required: true, maxLength: 100 },
          { key: 'categoryId', label: '分类 ID', type: 'number' },
          { key: 'specModel', label: '规格型号', maxLength: 100 },
          { key: 'amount', label: '金额', type: 'number', required: true },
          { key: 'purchaseAt', label: '入库时间', type: 'date' },
          { key: 'ownership', label: '资产归属', type: 'select', required: true, options: [{ label: '公司', value: 'COMPANY' }, { label: '合作方', value: 'PARTNER' }] },
          { key: 'ownerName', label: '合作方名称', maxLength: 100 },
          { key: 'departmentId', label: '所属部门 ID', type: 'number' },
          { key: 'responsibleUserId', label: '责任人 ID', type: 'number' },
          { key: 'currentUserId', label: '使用者 ID', type: 'number' },
          { key: 'remark', label: '备注', type: 'textarea', maxLength: 500 },
        ],
      } : undefined}
      edit={canMaintain ? {
        title: '编辑固定资产',
        fields: [
          { key: 'name', label: '资产名称', required: true, maxLength: 100 },
          { key: 'categoryId', label: '分类 ID', type: 'number' },
          { key: 'specModel', label: '规格型号', maxLength: 100 },
          { key: 'amount', label: '金额', type: 'number', required: true },
          { key: 'purchaseAt', label: '入库时间', type: 'date' },
          { key: 'ownership', label: '资产归属', type: 'select', required: true, options: [{ label: '公司', value: 'COMPANY' }, { label: '合作方', value: 'PARTNER' }] },
          { key: 'ownerName', label: '合作方名称', maxLength: 100 },
          { key: 'currentUserId', label: '使用者 ID', type: 'number' },
          { key: 'usageStatus', label: '使用状态', type: 'select', required: true, options: [{ label: '闲置', value: 'IDLE' }, { label: '使用中', value: 'IN_USE' }] },
          { key: 'remark', label: '备注', type: 'textarea', maxLength: 500 },
        ],
      } : undefined}
      batchDelete={canMaintain ? { endpoint: '/assets/batch', bodyKey: 'ids' } : undefined}
      exportConfig={{ allEndpoint: '/assets/export', filename: 'assets.xlsx' }}
      rowActions={canMaintain ? (row) => (
        <Space size="small">
          <Button size="small" onClick={() => setScheduleId(Number(row.id))}>调度</Button>
          {row.usageStatus !== 'SCRAPPED' ? (
            <Popconfirm title="确认报废该资产？报废是业务状态变更，不会删除台账。" onConfirm={() => void scrap(Number(row.id))}>
              <Button size="small" danger>报废</Button>
            </Popconfirm>
          ) : null}
        </Space>
      ) : undefined}
    />
    <ResourceFormModal title="资产调度" open={scheduleId !== null} onCancel={() => setScheduleId(null)} onSubmit={schedule} fields={[{ key: 'toDepartmentId', label: '目标部门 ID', type: 'number', required: true }, { key: 'toUserId', label: '目标责任人 ID', type: 'number', required: true }, { key: 'remark', label: '调度备注', type: 'textarea', maxLength: 200 }]} />
  </>;
}

/** 库存条目与入库批次：批次纠正由服务端重验追溯条件并写入库存流水。 */
function InventoryManagement() {
  const feedback = useFeedback();
  const [version, setVersion] = useState(0);
  const [batchId, setBatchId] = useState<number | null>(null);
  const correctBatch = async (values: Record<string, unknown>) => {
    if (batchId === null) return;
    const payload = {
      ...values,
      ...(values.unitPrice === undefined || values.unitPrice === null || values.unitPrice === '' ? {} : { unitPrice: String(values.unitPrice) }),
    };
    try {
      await http.post(`/inventory/batches/${batchId}/corrections`, payload, { service: 'asset' });
      feedback.success('库存批次已纠正');
      setBatchId(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '库存批次纠正失败');
    }
  };
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <DataTable key={`items-${version}`} title="消耗品库存" description="库存账面、占用与可用数量由服务端事务保持一致。" service="asset" endpoint="/inventory/items" pageKey="asset-inventory" columns={[{ key: 'id', title: 'ID', fixed: 'left' }, { key: 'consumableName', title: '品种' }, { key: 'warehouseName', title: '库位' }, { key: 'availableQty', title: '可用数量' }, { key: 'bookQty', title: '账面数量' }, { key: 'reservedQty', title: '占用数量' }, { key: 'lowStock', title: '低库存', render: (value: unknown) => <StatusTag value={value ? 'PENDING' : 'NORMAL'} /> }]} filterFields={[{ key: 'consumableId', title: '品种 ID', type: 'number' }, { key: 'warehouseId', title: '库位 ID', type: 'number' }]} />
    <DataTable key={`batches-${version}`} title="库存批次" description="查看批次来源与剩余数量；纠正供应商、品牌、单价、规格或库位前由服务端校验追溯与占用条件。" service="asset" endpoint="/inventory/batches" pageKey="asset-inventory-batches" columns={[{ key: 'id', title: '批次 ID', fixed: 'left' }, { key: 'consumableName', title: '品种' }, { key: 'spec', title: '规格' }, { key: 'warehouseName', title: '库位' }, { key: 'remainingQty', title: '剩余数量' }, { key: 'supplierName', title: '供应商' }, { key: 'unitPrice', title: '单价' }, { key: 'receivedAt', title: '入库时间' }]} filterFields={[{ key: 'inventoryItemId', title: '库存条目 ID', type: 'number' }, { key: 'consumableId', title: '品种 ID', type: 'number' }, { key: 'warehouseId', title: '库位 ID', type: 'number' }]} rowActions={(row) => <Button size="small" onClick={() => setBatchId(Number(row.id))}>纠正批次</Button>} />
    <ResourceFormModal title="纠正库存批次" open={batchId !== null} onCancel={() => setBatchId(null)} onSubmit={correctBatch} fields={[{ key: 'reason', label: '纠正原因', type: 'textarea', required: true, maxLength: 500 }, { key: 'supplierId', label: '供应商 ID', type: 'number' }, { key: 'brandId', label: '品牌 ID', type: 'number' }, { key: 'unitPrice', label: '单价（元）', type: 'number' }, { key: 'spec', label: '规格', maxLength: 100 }, { key: 'warehouseId', label: '目标库位 ID', type: 'number' }, { key: 'remark', label: '批次备注', type: 'textarea', maxLength: 500 }]} />
  </Space>;
}

/** 库存流水只读追加，导出由受保护接口生成完整 XLSX。 */
function StockFlows() {
  return (
    <DataTable
      title="库存流水"
      description="库存流水只追加，记录每次变动前后数量。"
      service="asset"
      endpoint="/inventory/stock-flows"
      pageKey="asset-stock-flows"
      columns={[
        { key: 'id', title: 'ID', fixed: 'left' },
        { key: 'flowType', title: '类型', render: (value: unknown) => <StatusTag value={value} /> },
        { key: 'consumableName', title: '品种' },
        { key: 'qty', title: '数量' },
        { key: 'warehouseName', title: '库位' },
        { key: 'createdAt', title: '发生时间' },
      ]}
      filterFields={[
        { key: 'consumableId', title: '品种 ID', type: 'number' },
        { key: 'flowType', title: '流水类型', type: 'enum', options: [{ label: '入库', value: 'STOCK_IN' }, { label: '领用', value: 'ISSUE' }, { label: '扣减', value: 'DEDUCTION' }, { label: '归还', value: 'RETURN' }, { label: '调出', value: 'TRANSFER_OUT' }, { label: '调入', value: 'TRANSFER_IN' }, { label: '纠正', value: 'CORRECTION' }] },
      ]}
      exportConfig={{ allEndpoint: '/inventory/stock-flows/export', filename: 'stock-flows.xlsx' }}
    />
  );
}

/** 维修单状态机操作：待维修可开始/取消，维修中可填写结果并完成。 */
function RepairManagement() {
  const feedback = useFeedback();
  const [version, setVersion] = useState(0);
  const [completeId, setCompleteId] = useState<number | null>(null);
  const run = async (id: number, action: 'start' | 'cancel', body: Record<string, unknown> = {}) => {
    try {
      await http.post(`/repair-orders/${id}/${action}`, body, { service: 'asset' });
      feedback.success(action === 'start' ? '维修已开始' : '维修已取消');
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, action === 'start' ? '开始维修失败' : '取消维修失败');
    }
  };
  const complete = async (values: Record<string, unknown>) => {
    if (!completeId) return;
    try {
      await http.post(`/repair-orders/${completeId}/complete`, values, { service: 'asset' });
      feedback.success('维修已完成');
      setCompleteId(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '完成维修失败');
    }
  };
  return <>
    <ResourcePage key={version} title="维修管理" description="维修登记、开始、完成与取消均由资产状态机控制。" service="asset" endpoint="/repair-orders" pageKey="asset-repairs" columns={[...COMMON_COLUMNS, { key: 'assetName', title: '资产' }, { key: 'status', title: '维修状态', render: (value: unknown) => <StatusTag value={value} /> }]} filterFields={[{ key: 'status', title: '状态', type: 'enum', options: [{ label: '待维修', value: 'PENDING' }, { label: '维修中', value: 'REPAIRING' }, { label: '已取消', value: 'CANCELLED' }, { label: '已完成', value: 'COMPLETED' }] }, { key: 'assetId', title: '资产 ID', type: 'number' }]} create={{ title: '登记维修', endpoint: '/repair-orders', fields: [{ key: 'assetId', label: '资产 ID', type: 'number', required: true }, { key: 'faultDescription', label: '故障/维修事项', type: 'textarea', required: true, maxLength: 1000 }] }} rowActions={(row) => <Space size="small">{row.status === 'PENDING' ? <><Popconfirm title="确认开始维修？" onConfirm={() => void run(Number(row.id), 'start')}><Button size="small">开始</Button></Popconfirm><Popconfirm title="确认取消维修登记？" onConfirm={() => void run(Number(row.id), 'cancel')}><Button size="small" danger>取消</Button></Popconfirm></> : null}{row.status === 'REPAIRING' ? <Button size="small" type="primary" onClick={() => setCompleteId(Number(row.id))}>完成维修</Button> : null}</Space>} />
    <ResourceFormModal title="完成维修" open={completeId !== null} onCancel={() => setCompleteId(null)} onSubmit={complete} fields={[{ key: 'result', label: '维修结果', type: 'textarea', required: true, maxLength: 1000 }, { key: 'actualCost', label: '实际费用', type: 'number', required: true }, { key: 'postStatus', label: '恢复资产状态', type: 'select', required: true, options: [{ label: '闲置', value: 'IDLE' }, { label: '使用中', value: 'IN_USE' }] }]} />
  </>;
}

/** 我的资产申请统一历史：不依赖审批权限，申请人/代交人可以取消待审批单。 */
/** 注销借还处置（asset PRD §9：待处置 / 处置记录两个视图，M28） */
function DisposalManagement() {
  const [tab, setTab] = useState<'PENDING' | 'RECORDS'>('PENDING');
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <Segmented
      value={tab}
      onChange={(value) => setTab(value as 'PENDING' | 'RECORDS')}
      options={[{ label: '待处置', value: 'PENDING' }, { label: '处置记录', value: 'RECORDS' }]}
    />
    {tab === 'PENDING' ? (
      <ResourcePage title="待处置" description="对已注销员工的未结清借还直接归还或核销；这是最终处置，不创建审批申请。" service="asset" endpoint="/disposals?tab=PENDING" pageKey="asset-disposals" columns={DISPOSAL_PENDING_COLUMNS} create={{ title: '执行直接处置', endpoint: '/disposals', fields: [{ key: 'disposalType', label: '处置类型', type: 'select', required: true, options: [{ label: '个人借还归还', value: 'RETURN' }, { label: '个人借还核销', value: 'WRITE_OFF' }, { label: '代领整单结清', value: 'AGENT_SETTLE' }] }, { key: 'items', label: '个人借还明细（JSON）', type: 'textarea', maxLength: 10000, placeholder: '[{"borrowRecordId":1,"method":"RETURN","qty":1}]' }, { key: 'agentRequestId', label: '代领申请 ID（仅整单结清）', type: 'number' }, { key: 'agentItems', label: '代领结清明细（JSON）', type: 'textarea', maxLength: 10000, placeholder: '[{"borrowRecordId":1,"method":"WRITE_OFF","writeOffType":"LOST","reason":"遗失","qty":1}]' }], transform: disposalPayload }} />
    ) : (
      <ResourcePage title="处置记录" description="按处理时间倒序显示数据范围内的管理员直接处置结果及关联库存流水摘要。" service="asset" endpoint="/disposals?tab=RECORDS" pageKey="asset-disposal-records" columns={DISPOSAL_RECORDS_COLUMNS} filterFields={[{ key: 'disposalType', title: '处置方式', type: 'enum', options: [{ label: '个人借还归还', value: 'RETURN' }, { label: '个人借还核销', value: 'WRITE_OFF' }, { label: '代领整单结清', value: 'AGENT_SETTLE' }] }]} />
    )}
  </Space>;
}

function MyAssetApplications() {
  const feedback = useFeedback();
  const [version, setVersion] = useState(0);
  const cancel = async (id: number) => {
    try {
      await http.post(`/approval-requests/${id}/cancel`, {}, { service: 'asset' });
      feedback.success('资产申请已取消');
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '取消资产申请失败');
    }
  };
  return <DataTable key={version} title="我的资产申请" description="查看本人提交或代交的全部资产申请；待审批状态可主动取消，取消后相关库存、额度或借还占用由服务端原子释放。" service="asset" endpoint="/approval-requests/mine" pageKey="asset-my-requests" columns={[{ key: 'id', title: 'ID', fixed: 'left' }, { key: 'applicationNo', title: '申请编号' }, { key: 'requestType', title: '申请类型' }, { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} /> }, { key: 'submittedAt', title: '提交时间' }, { key: 'processorName', title: '处理人' }, { key: 'opinion', title: '处理意见' }]} filterFields={[{ key: 'requestType', title: '申请类型', type: 'enum', options: [{ label: '入库申请', value: 'STOCK_IN' }, { label: '库存变更', value: 'STOCK_CHANGE' }, { label: '消耗品申领', value: 'CONSUMABLE_REQUEST' }, { label: '代领申请', value: 'AGENT_REQUEST' }, { label: '归还申请', value: 'RETURN' }, { label: '核销申请', value: 'WRITE_OFF' }, { label: '代领结清', value: 'AGENT_SETTLEMENT' }] }, { key: 'status', title: '状态', type: 'enum', options: [{ label: '待审批', value: 'PENDING' }, { label: '已批准', value: 'APPROVED' }, { label: '已驳回', value: 'REJECTED' }, { label: '已取消', value: 'CANCELLED' }] }, { key: 'keyword', title: '单号或申请人', type: 'text' }]} rowActions={(row) => row.status === 'PENDING' ? <Popconfirm title="确认取消该待审批资产申请？" onConfirm={() => void cancel(Number(row.id))}><Button size="small" danger>取消申请</Button></Popconfirm> : null} />;
}

function BorrowPage() {
  const feedback = useFeedback();
  const [version, setVersion] = useState(0);
  const [returnId, setReturnId] = useState<number | null>(null);
  const [writeOffId, setWriteOffId] = useState<number | null>(null);
  const [agentShared, setAgentShared] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    void http.get<{ agentShared?: Array<Record<string, unknown>> }>('/my-borrow?page=1&pageSize=20', { service: 'asset', active: true })
      .then((result) => setAgentShared(result.agentShared ?? []))
      .catch((error) => feedback.error(error, '代领共享清单加载失败'));
  }, [feedback, version]);
  const submitReturn = async (values: Record<string, unknown>) => {
    if (!returnId) return;
    try {
      await http.post('/borrow-returns', { items: [{ borrowRecordId: returnId, qty: Number(values.qty), reason: values.reason }] }, { service: 'asset' });
      feedback.success('归还申请已提交');
      setReturnId(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '归还申请提交失败');
    }
  };
  const submitWriteOff = async (values: Record<string, unknown>) => {
    if (!writeOffId) return;
    try {
      await http.post('/borrow-write-offs', { items: [{ borrowRecordId: writeOffId, qty: Number(values.qty), writeOffType: values.writeOffType, reason: values.reason }] }, { service: 'asset' });
      feedback.success('核销申请已提交');
      setWriteOffId(null);
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '核销申请提交失败');
    }
  };
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <DataTable key={version} title="我的借还" description="查看本人借还和代领共享清单；归还、核销均提交审批申请。" service="asset" endpoint="/my-borrow" pageKey="asset-my-borrow" columns={[{ key: 'id', title: '记录 ID', fixed: 'left' }, { key: 'consumableName', title: '资产/物品' }, { key: 'qty', title: '借出数量' }, { key: 'dueAt', title: '到期时间' }, { key: 'returnedQty', title: '已归还' }, { key: 'writtenOffQty', title: '已核销' }]} filterFields={[{ key: 'settlementStatus', title: '结清状态', type: 'enum', options: [{ label: '未结清', value: 'OPEN' }, { label: '已结清', value: 'SETTLED' }] }]} rowActions={(row) => <Space size="small"><Button size="small" onClick={() => setReturnId(Number(row.id))}>归还</Button><Button size="small" danger onClick={() => setWriteOffId(Number(row.id))}>核销</Button></Space>} />
    <Card title="代领共享清单（只读）" size="small"><Typography.Paragraph type="secondary">你作为受领人可查看整张共享清单；它不计入个人持有量，归还和结清只能由代领发起人完成。</Typography.Paragraph><Table<Record<string, unknown>> rowKey={(row) => String(row.id)} size="small" pagination={false} dataSource={agentShared} locale={{ emptyText: '暂无代领共享清单' }} columns={[{ key: 'id', title: '记录 ID', dataIndex: 'id' }, { key: 'proxyName', title: '代领人', dataIndex: 'proxyName' }, { key: 'consumableName', title: '物品', dataIndex: 'consumableName' }, { key: 'qty', title: '共享数量', dataIndex: 'qty' }, { key: 'dueAt', title: '到期时间', dataIndex: 'dueAt' }, { key: 'returnedQty', title: '已归还', dataIndex: 'returnedQty' }, { key: 'writtenOffQty', title: '已核销', dataIndex: 'writtenOffQty' }]} /></Card>
    <ResourceFormModal title="提交归还申请" open={returnId !== null} onCancel={() => setReturnId(null)} onSubmit={submitReturn} fields={[{ key: 'qty', label: '归还数量', type: 'number', required: true }, { key: 'reason', label: '归还备注', type: 'textarea', maxLength: 200 }]} />
    <ResourceFormModal title="提交核销申请" open={writeOffId !== null} onCancel={() => setWriteOffId(null)} onSubmit={submitWriteOff} fields={[{ key: 'qty', label: '核销数量', type: 'number', required: true }, { key: 'writeOffType', label: '核销类型', type: 'select', required: true, options: [{ label: '遗失', value: 'LOST' }, { label: '损坏', value: 'DAMAGED' }] }, { key: 'reason', label: '核销原因', type: 'textarea', required: true, maxLength: 500 }]} />
  </Space>;
}

/** 二维码停用、恢复与重新生成；公开标识不在页面日志或本地存储中保存。 */
function QrCodeManagement() {
  const feedback = useFeedback();
  const [version, setVersion] = useState(0);
  const perform = async (id: number, action: 'DISABLE' | 'ENABLE' | 'REGENERATE') => {
    try {
      await http.post(`/qr-codes/${id}/action`, { action }, { service: 'asset' });
      feedback.success(action === 'REGENERATE' ? '二维码已重新生成' : action === 'DISABLE' ? '二维码已停用' : '二维码已恢复');
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '二维码操作失败');
    }
  };
  return <ResourcePage key={version} title="二维码管理" description="二维码仅作扫码入口，不授予任何业务权限；作废后不可恢复，重新生成只更换公开标识。" service="asset" endpoint="/qr-codes" pageKey="asset-qr-codes" columns={[...COMMON_COLUMNS, { key: 'targetType', title: '目标类型' }, { key: 'status', title: '二维码状态', render: (value: unknown) => <StatusTag value={value} /> }]} create={{ title: '生成二维码', endpoint: '/qr-codes', fields: [{ key: 'targetType', label: '目标类型', type: 'select', required: true, options: [{ label: '固定资产', value: 'ASSET' }, { label: '库存条目', value: 'INVENTORY_ITEM' }, { label: '申领目录', value: 'SCAN_CATALOG' }] }, { key: 'targetId', label: '目标 ID', type: 'number' }] }} rowActions={(row) => <Space size="small">{row.status === 'ACTIVE' ? <Popconfirm title="确认停用二维码？" onConfirm={() => void perform(Number(row.id), 'DISABLE')}><Button size="small">停用</Button></Popconfirm> : row.status === 'DISABLED' ? <Popconfirm title="确认恢复二维码？" onConfirm={() => void perform(Number(row.id), 'ENABLE')}><Button size="small">恢复</Button></Popconfirm> : null}<Popconfirm title="确认作废当前二维码并重新生成？" onConfirm={() => void perform(Number(row.id), 'REGENERATE')}><Button size="small" danger>重新生成</Button></Popconfirm></Space>} />;
}

function ApprovalPage() {
  return <ApprovalCenter title="资产审批中心" service="asset" pageKey="asset-approval" />;
}

function AssetConfig() {
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <SettingsEditor title="资产运行参数" description="维护扫码入口和申领额度重置日；变更仅影响之后开始的业务周期。" service="asset" endpoint="/asset-settings" save={async (item, value) => {
      if (item.key === 'asset.scan.entry.url') {
        await http.put('/asset-settings', { scanEntryUrl: value }, { service: 'asset' });
        return;
      }
      if (item.key === 'asset.quota.reset.day') {
        await http.put('/asset-settings', { quotaResetDay: Number(value) }, { service: 'asset' });
        return;
      }
      throw new Error('未知的资产设置键');
    }} />
    <ResourcePage title="资产分类" service="asset" endpoint="/categories" pageKey="asset-categories" columns={COMMON_COLUMNS} create={{ title: '新建分类', endpoint: '/categories', fields: [{ key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'parentId', label: '父分类 ID', type: 'number', required: true }] }} edit={{ title: '编辑资产分类', endpoint: (id) => `/categories/${id}`, fields: [{ key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'sort', label: '排序', type: 'number' }, { key: 'status', label: '状态', type: 'select', required: true, options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }] }} batchDelete={{ endpoint: '/categories/batch', bodyKey: 'ids' }} />
    <ResourcePage title="业务字典" service="asset" endpoint="/dict-items" pageKey="asset-dicts" columns={[...COMMON_COLUMNS, { key: 'dictType', title: '类型' }]} create={{ title: '新建字典项', endpoint: '/dict-items', fields: [{ key: 'dictType', label: '字典类型', required: true }, { key: 'name', label: '名称', required: true, maxLength: 100 }] }} edit={{ title: '编辑字典项', endpoint: (id) => `/dict-items/${id}`, fields: [{ key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'sort', label: '排序', type: 'number' }, { key: 'status', label: '状态', type: 'select', required: true, options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }] }} batchDelete={{ endpoint: '/dict-items/batch', bodyKey: 'ids' }} />
  </Space>;
}

function parseJsonArray(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') throw new Error('明细必须是 JSON 数组');
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('明细必须是 JSON 数组');
    return parsed;
  } catch {
    throw new Error('明细 JSON 格式不正确');
  }
}

/** 组装注销借还直接处置请求；每次点击生成新幂等键，网络重试由请求层调用方复用。 */
function disposalPayload(values: Record<string, unknown>): Record<string, unknown> {
  const disposalType = String(values.disposalType ?? '');
  const payload: Record<string, unknown> = { disposalType, idempotencyKey: crypto.randomUUID() };
  if (disposalType === 'AGENT_SETTLE') {
    payload.agentRequestId = values.agentRequestId;
    payload.agentItems = parseJsonArray(values.agentItems);
  } else {
    payload.items = parseJsonArray(values.items);
  }
  return payload;
}
