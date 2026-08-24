import { Button, Card, Descriptions, Drawer, Form, Image, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams, Navigate } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import { AppShell, type NavigationItem } from '../../components/AppShell';
import { ConfirmAction } from '../../components/ConfirmAction';
import { ApprovalCenter } from '../../components/ApprovalCenter';
import { DataTable, StatusTag, type DataColumn } from '../../components/DataTable';
import { PageTabs } from '../../components/PageTabs';
import { ResourcePage } from '../../components/ResourcePage';
import { ResourceFormModal, type FormField } from '../../components/ResourceFormModal';
import {
  assetCategoryTreeSource,
  assetMaintainDepartmentsSource,
  assetMaintainEmployeesSource,
  warehouseTreeSource,
  stockInWarehouseTreeSource,
  consumablesSource,
  stockInConsumablesSource,
  inventoryItemsSource,
  claimInventoryItemsSource,
  agentClaimInventoryItemsSource,
  stockChangeInventoryItemsSource,
  assetsSource,
  assetDictSource,
  stockInDictSource,
  stockChangeTypeSource,
  myAgentRequestsSource,
  ownAgentOpenBorrowRecordsSource,
  pendingPersonalDisposalRecordsSource,
  pendingAgentDisposalRequestsSource,
  pendingAgentDisposalRecordsSource,
  agentRecipientsSource,
  departmentTreeSource,
  RemoteSelect,
} from '../../components/selectors';
import { SystemSettingsPage, type SystemSettingPresentation, type SystemSettingsGroup } from '../../components/SystemSettingsPage';
import { SystemHome } from '../../components/SystemHome';
import { MenuManagementTab } from '../../menu-config/MenuManagementTab';
import { useSystemMenuConfig } from '../../menu-config/useSystemMenuConfig';
import { formatBeijingDateTime, formatDisplayValue } from '../../components/display-format';
import { enumOptions, formatEnumLabel, type EnumKind } from '../../components/enum-display';
import { openQrPrintWindow } from '../../components/qr-print';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import { useSession } from '../../request/session';

type RecordValue = Record<string, unknown>;

/** 在列定义上按 key 标记可排序；用于共用列数组被不同端点复用的场景。 */
function markSortable(columns: DataColumn[], keys: string[]): DataColumn[] {
  return columns.map((column) => (keys.includes(column.key) ? { ...column, sortable: true } : column));
}

const NAVIGATION: NavigationItem[] = [
  { key: 'approval', label: '审批中心', path: '/asset/approval', permission: 'consumable_approval' },
  { key: 'config', label: '系统设置', path: '/asset/config', permission: 'asset_config' },
  { key: 'my-assets', label: '我的资产', path: '/asset/my-assets', permission: 'my_assets', group: '固定资产' },
  { key: 'assets', label: '固定资产台账', path: '/asset/assets', permission: ['fixed_asset_view', 'fixed_asset_maintain'], group: '固定资产' },
  { key: 'repairs', label: '维修管理', path: '/asset/repairs', permission: 'fixed_asset_maintain', group: '固定资产' },
  { key: 'qr-codes', label: '二维码管理', path: '/asset/qr-codes', permission: ['fixed_asset_maintain', 'inventory_manage'], group: '固定资产' },
  { key: 'consumables', label: '品类管理', path: '/asset/consumables', permission: 'inventory_manage', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'warehouses', label: '库位管理', path: '/asset/warehouses', permission: 'inventory_manage', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'inventory', label: '库存条目', path: '/asset/inventory', permission: 'inventory_manage', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'inventory-batches', label: '库存批次', path: '/asset/inventory-batches', permission: 'inventory_manage', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'stock-flows', label: '库存流水', path: '/asset/stock-flows', permission: 'inventory_manage', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'transfers', label: '库存调拨', path: '/asset/transfers', permission: 'inventory_manage', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'claims', label: '我的申领', path: '/asset/claims', permission: ['consumable_apply', 'consumable_apply_history'], group: '消耗品', subGroup: '消耗品申领' },
  { key: 'agent-claims', label: '代领申请', path: '/asset/agent-claims', permission: ['proxy_apply', 'consumable_apply_history'], group: '消耗品', subGroup: '消耗品申领' },
  { key: 'borrow', label: '借还核销', path: '/asset/borrow', permission: ['my_borrow', 'borrow_history'], group: '消耗品', subGroup: '消耗品申领' },
  { key: 'stock-in', label: '入库申请', path: '/asset/stock-in', permission: ['stock_in_apply', 'stock_in_history'], group: '消耗品', subGroup: '库存申请' },
  { key: 'stock-change', label: '库存变更申请', path: '/asset/stock-change', permission: ['stock_change_apply', 'stock_change_history'], group: '消耗品', subGroup: '库存申请' },
  { key: 'disposals-pending', label: '待处置', path: '/asset/disposals-pending', permission: 'consumable_approval', group: '消耗品', subGroup: '处置管理' },
  { key: 'disposals-records', label: '处置记录', path: '/asset/disposals-records', permission: 'consumable_approval', group: '消耗品', subGroup: '处置管理' },
];

const ASSET_COLUMNS = [
  { key: 'name', title: '资产名称', sortable: true },
  { key: 'categoryName', title: '分类' },
  { key: 'departmentName', title: '所属部门' },
  { key: 'usageStatus', title: '状态', enumKind: 'assetStatus' as const, render: (value: unknown) => <StatusTag value={value} enumKind="assetStatus" />, sortable: true },
  { key: 'responsibleUserName', title: '责任人' },
  { key: 'updatedAt', title: '更新时间', sortable: true },
];

const COMMON_COLUMNS = [
  { key: 'name', title: '名称' },
  { key: 'status', title: '状态', enumKind: 'dictionaryStatus' as const, render: (value: unknown) => <StatusTag value={value} enumKind="dictionaryStatus" /> },
  { key: 'createdAt', title: '创建时间' },
];

/** 姓名列（申请人/借用人）：已注销员工附"已注销"标记（主 PRD §2.6，M9）。 */
const nameColWithDeactivatedFlag = (key: 'applicantName' | 'userName', title: string, flagKey: 'applicantDeactivated' | 'userDeactivated') => ({
  key,
  title,
  sortable: true,
  render: (value: unknown, row: RecordValue) => (
    <span>
      {String(value ?? '')}
      {row[flagKey] ? <Tag color="red" style={{ marginLeft: 4 }}>已注销</Tag> : null}
    </span>
  ),
});

const REQUEST_COLUMNS = [
  { key: 'status', title: '状态', enumKind: 'approvalStatus' as const, render: (value: unknown) => <StatusTag value={value} enumKind="approvalStatus" />, sortable: true },
  { key: 'submittedAt', title: '提交时间', sortable: true },
];

const REPAIR_COLUMNS: DataColumn[] = [
  { key: 'name', title: '名称' },
  { key: 'assetName', title: '资产' },
  { key: 'status', title: '维修状态', enumKind: 'repairStatus', render: (value: unknown) => <StatusTag value={value} enumKind="repairStatus" /> },
  { key: 'createdAt', title: '创建时间' },
];

const ASSET_CHANGE_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: '资产名称',
  specModel: '规格型号',
  amount: '金额',
  usageStatus: '使用状态',
  currentUserId: '使用者',
  remark: '备注',
};

const ASSET_CHANGE_FIELD_ENUM_KINDS: Readonly<Record<string, EnumKind>> = {
  usageStatus: 'assetStatus',
};

function formatAssetChangeValue(field: unknown, value: unknown): string {
  const enumKind = ASSET_CHANGE_FIELD_ENUM_KINDS[String(field ?? '')];
  return enumKind ? formatEnumLabel(enumKind, value) : formatDisplayValue(value, String(field ?? ''));
}

/** 借还历史列（契约：对齐后端 borrow.service listHistory SELECT 字段，asset-page-columns.spec 断言）。 */
export const BORROW_HISTORY_COLUMNS = [
  { key: 'recordType', title: '记录类型', enumKind: 'borrowType' as const },
  nameColWithDeactivatedFlag('userName', '借用人/代交人', 'userDeactivated'),
  { key: 'consumableName', title: '物品', sortable: true },
  { key: 'qty', title: '数量', sortable: true },
  { key: 'borrowedAt', title: '借出时间' },
  { key: 'dueAt', title: '到期时间', sortable: true },
  { key: 'returnedQty', title: '已归还' },
  { key: 'writtenOffQty', title: '已核销' },
  { key: 'createdAt', title: '创建时间', sortable: true },
];

/** 待处置列（契约：对齐后端 disposal.service listPending SELECT 字段，asset-page-columns.spec 断言）。 */
export const DISPOSAL_PENDING_COLUMNS = [
  { key: 'recordType', title: '记录类型', enumKind: 'borrowType' as const },
  { key: 'userName', title: '目标用户' },
  { key: 'consumableName', title: '物品' },
  { key: 'qty', title: '数量' },
  { key: 'dueAt', title: '到期时间' },
];

/** 处置记录列（契约：对齐后端 disposal.service listRecords SELECT 字段，asset-page-columns.spec 断言）。 */
export const DISPOSAL_RECORDS_COLUMNS = [
  { key: 'recordType', title: '记录类型', enumKind: 'borrowType' as const },
  { key: 'userName', title: '目标用户', sortable: true },
  { key: 'consumableName', title: '物品' },
  { key: 'qty', title: '数量' },
  { key: 'disposalType', title: '处置方式', enumKind: 'disposalType' as const, sortable: true },
  { key: 'processorName', title: '处理人', sortable: true },
  { key: 'createdAt', title: '处理时间', sortable: true },
];

const ENABLED_STATUS_OPTIONS = [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }];
const APPROVAL_STATUS_OPTIONS = [{ label: '待审批', value: 'PENDING' }, { label: '已批准', value: 'APPROVED' }, { label: '已驳回', value: 'REJECTED' }, { label: '已取消', value: 'CANCELLED' }];
const ASSET_USAGE_STATUS_OPTIONS = [{ label: '闲置', value: 'IDLE' }, { label: '使用中', value: 'IN_USE' }, { label: '待维修', value: 'PENDING_REPAIR' }, { label: '维修中', value: 'REPAIRING' }, { label: '已报废', value: 'SCRAPPED' }];
const CONSUMABLE_TYPE_OPTIONS = [{ label: '一次性用品', value: 'DISPOSABLE' }, { label: '借还用品', value: 'REUSABLE' }];
const QUOTA_CYCLE_OPTIONS = [{ label: '月', value: 'MONTH' }, { label: '季度', value: 'QUARTER' }, { label: '年', value: 'YEAR' }];
const RETURN_WRITE_OFF_METHOD_OPTIONS = [{ label: '归还', value: 'RETURN' }, { label: '核销', value: 'WRITE_OFF' }];
const WRITE_OFF_TYPE_OPTIONS = [{ label: '遗失', value: 'LOST' }, { label: '损坏', value: 'DAMAGED' }];
const DISPOSAL_TYPE_OPTIONS = [{ label: '个人借还归还', value: 'RETURN' }, { label: '个人借还核销', value: 'WRITE_OFF' }, { label: '代领整单结清', value: 'AGENT_SETTLE' }];

const STOCK_IN_ITEM_COLUMNS: FormField[] = [
  { key: 'consumableId', label: '品种', type: 'remote-select', remote: stockInConsumablesSource, required: true },
  { key: 'supplierId', label: '供应商', type: 'remote-select', remote: stockInDictSource('SUPPLIER') },
  { key: 'brandId', label: '品牌', type: 'remote-select', remote: stockInDictSource('BRAND') },
  { key: 'spec', label: '规格', type: 'text', required: true, maxLength: 100 },
  { key: 'warehouseId', label: '库位', type: 'tree-select', remote: stockInWarehouseTreeSource, required: true },
  { key: 'qty', label: '数量', type: 'number', required: true, width: 'narrow' },
  { key: 'unitPrice', label: '单价', type: 'number', width: 'narrow' },
];

const STOCK_CHANGE_ITEM_COLUMNS: FormField[] = [
  { key: 'inventoryItemId', label: '库存条目', type: 'remote-select', remote: stockChangeInventoryItemsSource, required: true },
  { key: 'changeTypeId', label: '变更类型', type: 'remote-select', remote: stockChangeTypeSource, required: true },
  { key: 'reason', label: '变更原因', type: 'textarea', required: true, maxLength: 500 },
  { key: 'qty', label: '数量', type: 'number', required: true, width: 'narrow' },
];

const CLAIM_ITEM_COLUMNS: FormField[] = [
  { key: 'inventoryItemId', label: '库存条目', type: 'remote-select', remote: claimInventoryItemsSource, required: true },
  { key: 'qty', label: '数量', type: 'number', required: true, width: 'narrow' },
  { key: 'purpose', label: '用途', type: 'text', required: true, maxLength: 200 },
];

const AGENT_CLAIM_ITEM_COLUMNS: FormField[] = [
  { key: 'inventoryItemId', label: '库存条目', type: 'remote-select', remote: agentClaimInventoryItemsSource, required: true },
  { key: 'qty', label: '数量', type: 'number', required: true, width: 'narrow' },
  { key: 'purpose', label: '用途', type: 'text', maxLength: 200 },
];

const AGENT_SETTLEMENT_ITEM_COLUMNS: FormField[] = [
  { key: 'borrowRecordId', label: '借还记录', type: 'remote-select', remote: ownAgentOpenBorrowRecordsSource, remoteContextFrom: 'refRequestId', required: true },
  { key: 'method', label: '结清方式', type: 'select', required: true, options: RETURN_WRITE_OFF_METHOD_OPTIONS },
  { key: 'writeOffType', label: '核销类型', type: 'select', options: WRITE_OFF_TYPE_OPTIONS, visibleWhen: { field: 'method', equals: 'WRITE_OFF' }, requiredWhen: { field: 'method', equals: 'WRITE_OFF' } },
  { key: 'reason', label: '原因', type: 'textarea', maxLength: 500 },
  { key: 'qty', label: '数量', type: 'number', required: true, width: 'narrow' },
];

const PERSONAL_DISPOSAL_ITEM_COLUMNS: FormField[] = [
  { key: 'borrowRecordId', label: '个人借还记录', type: 'remote-select', remote: pendingPersonalDisposalRecordsSource, required: true },
  { key: 'writeOffType', label: '核销类型', type: 'select', options: WRITE_OFF_TYPE_OPTIONS, visibleWhen: { field: 'disposalType', equals: 'WRITE_OFF' }, requiredWhen: { field: 'disposalType', equals: 'WRITE_OFF' } },
  { key: 'reason', label: '原因或备注', type: 'textarea', maxLength: 500 },
  { key: 'qty', label: '数量', type: 'number', required: true, width: 'narrow' },
];

const AGENT_DISPOSAL_ITEM_COLUMNS: FormField[] = [
  { key: 'borrowRecordId', label: '代领借还记录', type: 'remote-select', remote: pendingAgentDisposalRecordsSource, remoteContextFrom: 'agentRequestId', required: true },
  { key: 'method', label: '结清方式', type: 'select', required: true, options: RETURN_WRITE_OFF_METHOD_OPTIONS },
  { key: 'writeOffType', label: '核销类型', type: 'select', options: WRITE_OFF_TYPE_OPTIONS, visibleWhen: { field: 'method', equals: 'WRITE_OFF' }, requiredWhen: { field: 'method', equals: 'WRITE_OFF' } },
  { key: 'reason', label: '原因', type: 'textarea', maxLength: 500 },
  { key: 'qty', label: '数量', type: 'number', required: true, width: 'narrow' },
];

const CONSUMABLE_CREATE_FIELDS: FormField[] = [
  { key: 'name', label: '名称', required: true, maxLength: 50, group: '基本信息' },
  { key: 'type', label: '品种类型', type: 'select', required: true, options: CONSUMABLE_TYPE_OPTIONS, group: '基本信息' },
  { key: 'unitId', label: '单位', type: 'remote-select', remote: assetDictSource('UNIT'), group: '基本信息' },
  { key: 'categoryId', label: '分类', type: 'tree-select', remote: assetCategoryTreeSource, group: '基本信息' },
  { key: 'quotaCycle', label: '配额周期', type: 'select', options: QUOTA_CYCLE_OPTIONS, group: '一次性用品配额' },
  { key: 'quotaLimit', label: '数量上限', type: 'number', group: '一次性用品配额', width: 'narrow' },
  { key: 'returnDays', label: '借还期限（天）', type: 'number', group: '借还用品限制', width: 'narrow' },
  { key: 'maxHolding', label: '同时持有上限', type: 'number', group: '借还用品限制', width: 'narrow' },
  { key: 'referencePrice', label: '参考单价', type: 'number', group: '库存参数', width: 'narrow' },
  { key: 'safetyStock', label: '安全库存', type: 'number', group: '库存参数', width: 'narrow' },
];

const CONSUMABLE_EDIT_FIELDS: FormField[] = [
  { key: 'name', label: '名称', required: true, maxLength: 50, group: '基本信息' },
  { key: 'type', label: '品种类型', type: 'select', required: true, options: CONSUMABLE_TYPE_OPTIONS, group: '基本信息' },
  { key: 'categoryId', label: '分类', type: 'tree-select', remote: assetCategoryTreeSource, group: '基本信息' },
  { key: 'quotaCycle', label: '配额周期', type: 'select', options: QUOTA_CYCLE_OPTIONS, group: '一次性用品配额' },
  { key: 'quotaLimit', label: '数量上限', type: 'number', group: '一次性用品配额', width: 'narrow' },
  { key: 'returnDays', label: '借还期限（天）', type: 'number', group: '借还用品限制', width: 'narrow' },
  { key: 'maxHolding', label: '同时持有上限', type: 'number', group: '借还用品限制', width: 'narrow' },
  { key: 'referencePrice', label: '参考单价', type: 'number', group: '库存参数', width: 'narrow' },
  { key: 'safetyStock', label: '安全库存', type: 'number', required: true, group: '库存参数', width: 'narrow' },
  { key: 'status', label: '状态', type: 'select', required: true, options: ENABLED_STATUS_OPTIONS, group: '状态', width: 'narrow' },
];

/** 资产系统路由容器。 */
export default function AssetPage() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] ?? '';
  const { items: navigationItems, reload: reloadMenuConfig } = useSystemMenuConfig('ASSET', NAVIGATION);
  const body = useMemo(() => {
    switch (section) {
      case 'my-assets':
        return <MyAssets />;
      case 'assets':
        return <FixedAssets />;
      case 'repairs':
        return <RepairManagement />;
      case 'consumables':
        return <ResourcePage title="消耗品配置" service="asset" endpoint="/consumables" pageKey="asset-consumables" columns={markSortable([...COMMON_COLUMNS, { key: 'unitName', title: '单位' }, { key: 'categoryName', title: '分类' }], ['name', 'status', 'createdAt'])} filterFields={[{ key: 'keyword', title: '关键字', type: 'text' }, { key: 'status', title: '状态', type: 'enum', options: ENABLED_STATUS_OPTIONS }]} create={{ title: '新建消耗品', endpoint: '/consumables', fields: CONSUMABLE_CREATE_FIELDS }} edit={{ title: '编辑消耗品', fields: CONSUMABLE_EDIT_FIELDS }} batchDelete={{ endpoint: '/consumables/batch', bodyKey: 'ids' }} />;
      case 'warehouses':
        return <ResourcePage title="库位管理" service="asset" endpoint="/warehouses/tree" pageKey="asset-warehouses" columns={markSortable([...COMMON_COLUMNS, { key: 'parentName', title: '上级库位' }, { key: 'sort', title: '排序' }], ['name', 'status', 'createdAt', 'updatedAt', 'sort'])} filterFields={[{ key: 'status', title: '状态', type: 'enum', options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }] }]} create={{ title: '新建库位', endpoint: '/warehouses', fields: [{ key: 'name', label: '库位名称', required: true, maxLength: 50 }, { key: 'parentId', label: '上级库位', type: 'tree-select', remote: warehouseTreeSource }, { key: 'sort', label: '排序', type: 'number', width: 'narrow' }] }} edit={{ title: '编辑库位', endpoint: (id) => `/warehouses/${id}`, fields: [{ key: 'name', label: '库位名称', required: true, maxLength: 50 }, { key: 'parentId', label: '上级库位', type: 'tree-select', remote: warehouseTreeSource }, { key: 'sort', label: '排序', type: 'number', width: 'narrow' }, { key: 'status', label: '状态', type: 'select', required: true, options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }], width: 'narrow' }] }} batchDelete={{ endpoint: '/warehouses/batch', bodyKey: 'ids', previewEndpoint: '/warehouses/delete-preview', previewItem: (item) => ({ name: String(item.name ?? '—'), refs: `现存库存条目 ${String(item.inventoryItemCount ?? 0)} 个；未结清借还 ${String(item.borrowCount ?? 0)} 条；待审批引用 ${String(item.pendingCount ?? 0)} 处` }) }} />;
      case 'inventory':
        return <InventoryItems />;
      case 'inventory-batches':
        return <InventoryBatches />;
      case 'stock-flows':
        return <StockFlows />;
      case 'transfers':
        return <ResourcePage title="库存调拨" service="asset" endpoint="/asset/inventory-transfers" pageKey="asset-inventory-transfers" columns={[{ key: 'fromWarehouseName', title: '来源库位', sortable: true }, { key: 'toWarehouseName', title: '目标库位', sortable: true }, { key: 'qty', title: '数量', sortable: true }, { key: 'operatorName', title: '操作人', sortable: true }, { key: 'createdAt', title: '调拨时间', sortable: true }]} create={{ title: '发起调拨', fields: [{ key: 'fromInventoryItemId', label: '来源库存条目', type: 'remote-select', remote: inventoryItemsSource, required: true, width: 'wide' }, { key: 'toWarehouseId', label: '目标库位', type: 'tree-select', remote: warehouseTreeSource, required: true }, { key: 'qty', label: '数量', type: 'number', required: true, width: 'narrow' }, { key: 'remark', label: '备注', type: 'textarea', maxLength: 200 }] }} />;
      case 'stock-in':
        return <PageTabs items={[
          { key: 'apply', label: '入库申请', permission: 'stock_in_apply', children: <ResourcePage title="入库申请" service="asset" endpoint="/stock-in-requests/mine" pageKey="asset-stock-in" columns={markSortable([...REQUEST_COLUMNS, { key: 'applicantName', title: '申请人' }], ['status', 'submittedAt', 'applicantName'])} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]} create={{ title: '新建入库申请', endpoint: '/stock-in-requests', fields: [{ key: 'items', label: '入库明细', type: 'detail-list', required: true, detailColumns: STOCK_IN_ITEM_COLUMNS, detailMinRows: 1 }, { key: 'remark', label: '备注', type: 'textarea', maxLength: 500 }] }} /> },
          { key: 'history', label: '历史记录', permission: 'stock_in_history', children: <ResourcePage title="入库申请历史" service="asset" endpoint="/stock-in-requests" pageKey="asset-stock-in-history" columns={[...REQUEST_COLUMNS, nameColWithDeactivatedFlag('applicantName', '申请人', 'applicantDeactivated')]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }, { key: 'applicantName', title: '发起人姓名', type: 'text' }]} /> },
        ]} />;
      case 'stock-in-history':
        return <Navigate to="/asset/stock-in?tab=history" replace />;
      case 'stock-change':
        return <PageTabs items={[
          { key: 'apply', label: '变更申请', permission: 'stock_change_apply', children: <ResourcePage title="库存变更申请" service="asset" endpoint="/stock-change-requests/mine" pageKey="asset-stock-change" columns={markSortable([...REQUEST_COLUMNS, { key: 'applicantName', title: '申请人' }], ['status', 'submittedAt', 'applicantName'])} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]} create={{ title: '新建库存变更申请', endpoint: '/stock-change-requests', fields: [{ key: 'items', label: '变更明细', type: 'detail-list', required: true, detailColumns: STOCK_CHANGE_ITEM_COLUMNS, detailMinRows: 1 }] }} /> },
          { key: 'history', label: '历史记录', permission: 'stock_change_history', children: <ResourcePage title="库存变更历史" service="asset" endpoint="/stock-change-requests" pageKey="asset-stock-change-history" columns={[...REQUEST_COLUMNS, nameColWithDeactivatedFlag('applicantName', '申请人', 'applicantDeactivated')]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }, { key: 'applicantName', title: '发起人姓名', type: 'text' }]} /> },
        ]} />;
      case 'stock-change-history':
        return <Navigate to="/asset/stock-change?tab=history" replace />;
      case 'claims':
        return <PageTabs items={[
          { key: 'apply', label: '申领申请', permission: 'consumable_apply', children: <ClaimRequests /> },
          { key: 'history', label: '历史记录', permission: 'consumable_apply_history', children: <ResourcePage title="申领历史" service="asset" endpoint="/consumable-requests" pageKey="asset-claim-history" columns={[...REQUEST_COLUMNS, nameColWithDeactivatedFlag('applicantName', '申请人', 'applicantDeactivated')]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }, { key: 'applicantName', title: '发起人姓名', type: 'text' }]} /> },
        ]} />;
      case 'claim-history':
        return <Navigate to="/asset/claims?tab=history" replace />;
      case 'agent-claims':
        return <PageTabs items={[
          { key: 'apply', label: '代领申请', permission: 'proxy_apply', children: <AgentClaims /> },
          { key: 'settlement', label: '代领结清', permission: 'proxy_apply', children: <ResourcePage title="代领整单结清" service="asset" endpoint="/agent-settlements/mine" pageKey="asset-agent-settlements" columns={markSortable([...REQUEST_COLUMNS, { key: 'applicationNo', title: '申请编号' }], ['status', 'submittedAt', 'applicationNo'])} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]} create={{ title: '提交代领整单结清', endpoint: '/agent-settlements', fields: [{ key: 'refRequestId', label: '代领申请', type: 'remote-select', remote: myAgentRequestsSource, required: true, width: 'wide' }, { key: 'items', label: '结清明细', type: 'detail-list', required: true, detailColumns: AGENT_SETTLEMENT_ITEM_COLUMNS, detailMinRows: 1, remoteContextFrom: 'refRequestId', resetWhenDependencyChanges: true }] }} /> },
          { key: 'history', label: '历史记录', permission: 'consumable_apply_history', children: <ResourcePage title="代领申请历史" service="asset" endpoint="/agent-requests" pageKey="asset-agent-claims-history" columns={[...REQUEST_COLUMNS, nameColWithDeactivatedFlag('applicantName', '代领人', 'applicantDeactivated'), { key: 'recipientCount', title: '受领人数' }]} filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }, { key: 'applicantName', title: '代领人姓名', type: 'text' }]} /> },
        ]} />;
      case 'agent-settlements':
        return <Navigate to="/asset/agent-claims?tab=settlement" replace />;
      case 'borrow':
        return <PageTabs items={[
          { key: 'mine', label: '我的借还', permission: 'my_borrow', children: <MyBorrow /> },
          { key: 'shared', label: '共享清单', permission: 'my_borrow', children: <AgentSharedList /> },
          { key: 'history', label: '借还历史', permission: 'borrow_history', children: <ResourcePage title="借还历史" service="asset" endpoint="/borrow-records" pageKey="asset-borrow-history" columns={BORROW_HISTORY_COLUMNS} filterFields={[{ key: 'keyword', title: '物品/借用人关键字', type: 'text' }]} /> },
        ]} />;
      case 'agent-shared':
        return <Navigate to="/asset/borrow?tab=shared" replace />;
      case 'borrow-history':
        return <Navigate to="/asset/borrow?tab=history" replace />;
      case 'disposals-pending':
        return <ResourcePage title="待处置" service="asset" endpoint="/disposals?tab=PENDING" pageKey="asset-disposals" columns={DISPOSAL_PENDING_COLUMNS} create={{ title: '执行直接处置', endpoint: '/disposals', fields: [{ key: 'disposalType', label: '处置类型', type: 'select', required: true, options: DISPOSAL_TYPE_OPTIONS }, { key: 'items', label: '个人借还明细', type: 'detail-list', detailColumns: PERSONAL_DISPOSAL_ITEM_COLUMNS, detailMinRows: 1, visibleWhen: { field: 'disposalType', equals: ['RETURN', 'WRITE_OFF'] } }, { key: 'agentRequestId', label: '代领申请', type: 'remote-select', remote: pendingAgentDisposalRequestsSource, required: true, width: 'wide', visibleWhen: { field: 'disposalType', equals: 'AGENT_SETTLE' } }, { key: 'agentItems', label: '代领结清明细', type: 'detail-list', detailColumns: AGENT_DISPOSAL_ITEM_COLUMNS, detailMinRows: 1, remoteContextFrom: 'agentRequestId', resetWhenDependencyChanges: true, visibleWhen: { field: 'disposalType', equals: 'AGENT_SETTLE' } }], transform: disposalPayload }} />;
      case 'disposals-records':
        return <ResourcePage title="处置记录" service="asset" endpoint="/disposals?tab=RECORDS" pageKey="asset-disposal-records" columns={DISPOSAL_RECORDS_COLUMNS} filterFields={[{ key: 'disposalType', title: '处置方式', type: 'enum', options: DISPOSAL_TYPE_OPTIONS }]} />;
      case 'qr-codes':
        return <QrCodeManagement />;
      case 'approval':
        return <ApprovalPage />;
      case 'config':
        return <AssetConfig onMenuSaved={reloadMenuConfig} />;
      default:
        return <SystemHome items={navigationItems} />;
    }
  }, [section, navigationItems, reloadMenuConfig]);
  return <AppShell systemName="资产系统" homePath="/asset" items={navigationItems}>{body}</AppShell>;
}

/** 我的资产：点行打开资产详情（asset PRD §4：详情/主图/二维码/历史）；扫码以 ?assetId= 直达详情。 */
function MyAssets() {
  const [searchParams] = useSearchParams();
  const scannedAssetId = searchParams.get('assetId');
  const [detailId, setDetailId] = useState<number | null>(null);
  // 扫码直达：组件不卸载时再次扫码仅 query 变化，需监听 assetId 同步打开详情抽屉。
  useEffect(() => {
    if (scannedAssetId) {
      setDetailId(Number(scannedAssetId));
    }
  }, [scannedAssetId]);
  return <>
    <DataTable title="我的资产" service="asset" endpoint="/assets/mine" pageKey="asset-my-assets" columns={ASSET_COLUMNS} filterFields={[{ key: 'scope', title: '范围', type: 'enum', options: [{ label: '负责', value: 'OWNED' }, { label: '使用', value: 'USED' }, { label: '全部', value: 'ALL' }] }]} onRowClick={(row) => setDetailId(Number(row.id))} />
    <AssetDetailDrawer assetId={detailId} onClose={() => setDetailId(null)} />
  </>;
}

/** 资产详情抽屉：基本信息、主图、二维码与调度/变更/维修历史（asset PRD §4）。 */
function AssetDetailDrawer({ assetId, onClose }: { assetId: number | null; onClose: () => void }) {
  const feedback = useFeedback();
  const [detail, setDetail] = useState<RecordValue | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [qr, setQr] = useState<RecordValue | null>(null);
  useEffect(() => {
    if (assetId === null) {
      setDetail(null);
      setImageUrl(null);
      setQr(null);
      return;
    }
    void (async () => {
      try {
        const [asset, qrResult] = await Promise.all([
          http.get<RecordValue>(`/assets/${assetId}`, { service: 'asset', active: true }),
          http.get<{ data?: Array<RecordValue> }>(`/qr-codes?targetType=ASSET&targetId=${assetId}&page=1&pageSize=5`, { service: 'asset', active: true }),
        ]);
        setDetail(asset);
        const activeQr = (qrResult.data ?? []).find((row) => row.status === 'ACTIVE');
        setQr(activeQr ?? null);
        if (typeof asset.imageOssKey === 'string' && asset.imageOssKey) {
          const download = await http.get<{ downloadUrl?: string }>(`/files/images/download?objectKey=${encodeURIComponent(asset.imageOssKey)}`, { active: true });
          setImageUrl(download.downloadUrl ?? null);
        } else {
          setImageUrl(null);
        }
      } catch (error) {
        feedback.error(error, '资产详情加载失败');
      }
    })();
  }, [assetId, feedback]);
  const transfers = Array.isArray(detail?.transfers) ? detail?.transfers as Array<RecordValue> : [];
  const changes = Array.isArray(detail?.changes) ? detail?.changes as Array<RecordValue> : [];
  const repairOrders = Array.isArray(detail?.repairOrders) ? detail?.repairOrders as Array<RecordValue> : [];
  const basicItems: Array<{ label: string; children: React.ReactNode }> = (
    [
      ['name', '资产名称'], ['categoryName', '分类'], ['specModel', '规格型号'],
      ['departmentName', '所属部门'], ['responsibleUserName', '责任人'], ['currentUserName', '使用者'],
      ['usageStatus', '使用状态'], ['ownership', '资产归属'], ['ownerName', '合作方名称'],
      ['amount', '金额'], ['purchaseAt', '入库时间'], ['remark', '备注'], ['updatedAt', '更新时间'],
    ] as Array<[string, string]>
  ).filter(([key]) => detail?.[key] !== undefined && detail[key] !== null).map(([key, label]) => ({
    label,
    children: <span>{key === 'usageStatus' ? formatEnumLabel('assetStatus', detail?.[key]) : key === 'ownership' ? formatEnumLabel('assetOwnership', detail?.[key]) : key === 'purchaseAt' || key === 'updatedAt' ? formatBeijingDateTime(String(detail?.[key] ?? '')) : String(detail?.[key] ?? '—')}</span>,
  }));
  return <Drawer title="资产详情" open={assetId !== null} onClose={onClose} width="min(92vw, 720px)">
    {detail ? <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {imageUrl ? <Image src={imageUrl} alt="资产主图" style={{ maxWidth: 320, maxHeight: 240, objectFit: 'contain' }} /> : null}
      <Descriptions bordered column={1} size="small" items={basicItems} />
      <Card size="small" title="二维码">
        {qr && typeof qr.publicId === 'string' ? (
          <Space direction="vertical" size="small">
            <QRCodeCanvas value={`${window.location.origin}/scan#${qr.publicId}`} size={140} />
            <Typography.Text type="secondary">扫码查看资产入口</Typography.Text>
          </Space>
        ) : <Typography.Text type="secondary">未生成有效二维码</Typography.Text>}
      </Card>
      <Tabs items={[
        { key: 'transfers', label: `调度记录（${transfers.length}）`, children: historyTable(transfers, [
          { key: 'createdAt', title: '时间' }, { key: 'toDepartmentName', title: '目标部门' }, { key: 'toUserName', title: '目标责任人' }, { key: 'remark', title: '备注' },
        ]) },
        { key: 'changes', label: `变更记录（${changes.length}）`, children: historyTable(changes, [
          { key: 'createdAt', title: '时间' }, { key: 'changedField', title: '变更字段', render: (value: unknown) => ASSET_CHANGE_FIELD_LABELS[String(value ?? '')] ?? '未知字段' }, { key: 'oldValue', title: '变更前', render: (value: unknown, row: RecordValue) => formatAssetChangeValue(row.changedField, value) }, { key: 'newValue', title: '变更后', render: (value: unknown, row: RecordValue) => formatAssetChangeValue(row.changedField, value) }, { key: 'operatorName', title: '操作人' },
        ]) },
        { key: 'repairs', label: `维修单（${repairOrders.length}）`, children: historyTable(repairOrders, [
          { key: 'createdAt', title: '登记时间' }, { key: 'status', title: '状态', render: (value: unknown) => <StatusTag value={value} enumKind="repairStatus" /> }, { key: 'faultDescription', title: '故障/维修事项' }, { key: 'result', title: '维修结果' }, { key: 'actualCost', title: '实际费用' },
        ]) },
      ]} />
    </Space> : <Typography.Text>正在加载...</Typography.Text>}
  </Drawer>;
}

function historyTable(rows: Array<RecordValue>, columns: Array<{ key: string; title: string; render?: (value: unknown, row: RecordValue) => React.ReactNode }>) {
  return <Table<RecordValue> size="small" rowKey={(row, index) => `${String(row.id ?? '')}-${String(index)}`} pagination={false} dataSource={rows} locale={{ emptyText: '暂无记录' }} columns={columns.map((column) => ({ ...column, dataIndex: column.key, render: column.render ?? ((value: unknown) => <span style={{ whiteSpace: 'pre-wrap' }}>{formatDisplayValue(value, column.key)}</span>) }))} />;
}

function FixedAssets() {
  const feedback = useFeedback();
  const { can } = useSession();
  const canMaintain = can('fixed_asset_maintain');
  const [searchParams] = useSearchParams();
  const scannedAssetId = searchParams.get('assetId');
  const [version, setVersion] = useState(0);
  const [scheduleId, setScheduleId] = useState<number | null>(null);
  const [scheduleRow, setScheduleRow] = useState<RecordValue | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  // 扫码直达：组件不卸载时再次扫码仅 query 变化，需监听 assetId 同步打开详情抽屉。
  useEffect(() => {
    if (scannedAssetId) {
      setDetailId(Number(scannedAssetId));
    }
  }, [scannedAssetId]);
  const schedule = async (values: RecordValue) => {
    if (!scheduleId) return;
    if (scheduleRow
      && Number(values.toDepartmentId) === Number(scheduleRow.departmentId)
      && Number(values.toUserId) === Number(scheduleRow.responsibleUserId)) {
      feedback.info('部门与责任人均未变化，无需调度');
      setScheduleId(null);
      setScheduleRow(null);
      return;
    }
    try {
      await http.post(`/assets/${scheduleId}/schedule`, values, { service: 'asset' });
      feedback.success('资产调度已完成');
      setScheduleId(null);
      setScheduleRow(null);
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
      service="asset"
      endpoint="/assets"
      pageKey="asset-ledger"
      columns={ASSET_COLUMNS}
      filterFields={[
        { key: 'keyword', title: '关键字', type: 'text' },
        { key: 'usageStatus', title: '状态', type: 'enum', options: ASSET_USAGE_STATUS_OPTIONS },
        { key: 'departmentId', title: '所属部门', type: 'tree', remote: departmentTreeSource },
      ]}
      create={canMaintain ? {
        title: '新建固定资产',
        fields: [
          { key: 'name', label: '资产名称', required: true, maxLength: 100, group: '基本信息' },
          { key: 'categoryId', label: '分类', type: 'tree-select', remote: assetCategoryTreeSource, group: '基本信息' },
          { key: 'specModel', label: '规格型号', maxLength: 100, group: '基本信息' },
          { key: 'amount', label: '金额', type: 'number', required: true, width: 'narrow', group: '基本信息' },
          { key: 'purchaseAt', label: '入库时间', type: 'date', group: '基本信息' },
          { key: 'ownership', label: '资产归属', type: 'select', required: true, options: [{ label: '公司', value: 'COMPANY' }, { label: '合作方', value: 'PARTNER' }], width: 'narrow', group: '归属与责任人' },
          { key: 'ownerName', label: '合作方名称', maxLength: 100, group: '归属与责任人' },
          { key: 'departmentId', label: '所属部门', type: 'tree-select', remote: assetMaintainDepartmentsSource, group: '归属与责任人' },
          { key: 'responsibleUserId', label: '责任人', type: 'remote-select', remote: assetMaintainEmployeesSource, dependsOn: 'departmentId', group: '归属与责任人' },
          { key: 'currentUserId', label: '使用者', type: 'remote-select', remote: assetMaintainEmployeesSource, dependsOn: 'departmentId', group: '归属与责任人' },
          { key: 'remark', label: '备注', type: 'textarea', maxLength: 500 },
        ],
      } : undefined}
      edit={canMaintain ? {
        title: '编辑固定资产',
        fields: [
          { key: 'name', label: '资产名称', required: true, maxLength: 100, group: '基本信息' },
          { key: 'categoryId', label: '分类', type: 'tree-select', remote: assetCategoryTreeSource, group: '基本信息' },
          { key: 'specModel', label: '规格型号', maxLength: 100, group: '基本信息' },
          { key: 'amount', label: '金额', type: 'number', required: true, width: 'narrow', group: '基本信息' },
          { key: 'purchaseAt', label: '入库时间', type: 'date', group: '基本信息' },
          { key: 'ownership', label: '资产归属', type: 'select', required: true, options: [{ label: '公司', value: 'COMPANY' }, { label: '合作方', value: 'PARTNER' }], width: 'narrow', group: '归属与责任人' },
          { key: 'ownerName', label: '合作方名称', maxLength: 100, group: '归属与责任人' },
          { key: 'currentUserId', label: '使用者', type: 'remote-select', remote: assetMaintainEmployeesSource, group: '归属与责任人' },
          { key: 'usageStatus', label: '使用状态', type: 'select', required: true, options: [{ label: '闲置', value: 'IDLE' }, { label: '使用中', value: 'IN_USE' }], width: 'narrow', group: '归属与责任人' },
          { key: 'remark', label: '备注', type: 'textarea', maxLength: 500 },
        ],
      } : undefined}
      batchDelete={canMaintain ? { endpoint: '/assets/batch', bodyKey: 'ids' } : undefined}
      exportConfig={{ allEndpoint: '/assets/export', filename: 'assets.xlsx' }}
      rowActions={canMaintain ? (row) => (
        <Space size="small">
          <Button size="small" onClick={() => setDetailId(Number(row.id))}>详情</Button>
          <Button size="small" onClick={() => { setScheduleRow(row); setScheduleId(Number(row.id)); }}>调度</Button>
          {row.usageStatus !== 'SCRAPPED' ? (
            <Popconfirm title="确认报废该资产？报废是业务状态变更，不会删除台账。" onConfirm={() => void scrap(Number(row.id))}>
              <Button size="small" danger>报废</Button>
            </Popconfirm>
          ) : null}
        </Space>
      ) : (row) => <Button size="small" onClick={() => setDetailId(Number(row.id))}>详情</Button>}
    />
    <ResourceFormModal title="资产调度" open={scheduleId !== null} onCancel={() => { setScheduleId(null); setScheduleRow(null); }} onSubmit={schedule} submitDisabled={(values) => Boolean(scheduleRow && Number(values.toDepartmentId) === Number(scheduleRow.departmentId) && Number(values.toUserId) === Number(scheduleRow.responsibleUserId))} fields={[{ key: 'toDepartmentId', label: '目标部门', type: 'tree-select', remote: assetMaintainDepartmentsSource, required: true }, { key: 'toUserId', label: '目标责任人', type: 'remote-select', remote: assetMaintainEmployeesSource, dependsOn: 'toDepartmentId', required: true }, { key: 'remark', label: '调度备注', type: 'textarea', maxLength: 200 }]} />
    <AssetDetailDrawer assetId={detailId} onClose={() => setDetailId(null)} />
  </>;
}

/** 库存条目：点行查看条目详情（含该条目批次与「查看全部批次」跳转）。 */
function InventoryItems() {
  const [detailId, setDetailId] = useState<number | null>(null);
  return <>
    <DataTable title="库存条目" service="asset" endpoint="/inventory/items" pageKey="asset-inventory" columns={[{ key: 'consumableName', title: '品种' }, { key: 'warehouseName', title: '库位', sortable: true }, { key: 'availableQty', title: '可用数量' }, { key: 'bookQty', title: '账面数量', sortable: true }, { key: 'reservedQty', title: '占用数量', sortable: true }, { key: 'lowStock', title: '低库存', render: (value: unknown) => <StatusTag value={value ? 'PENDING' : 'NORMAL'} enumKind="lowStockStatus" /> }]} filterFields={[{ key: 'consumableId', title: '品种', type: 'remote', remote: consumablesSource }, { key: 'warehouseId', title: '库位', type: 'tree', remote: warehouseTreeSource }]} onRowClick={(row) => setDetailId(Number(row.id))} />
    <InventoryItemDrawer itemId={detailId} onClose={() => setDetailId(null)} />
  </>;
}

/** 库存条目详情：条目信息 + 该条目批次；提供跳转批次页入口。 */
function InventoryItemDrawer({ itemId, onClose }: { itemId: number | null; onClose: () => void }) {
  const feedback = useFeedback();
  const navigate = useNavigate();
  const [item, setItem] = useState<RecordValue | null>(null);
  const [batches, setBatches] = useState<RecordValue[]>([]);
  useEffect(() => {
    if (itemId === null) {
      setItem(null);
      setBatches([]);
      return;
    }
    void (async () => {
      try {
        const [itemResult, batchResult] = await Promise.all([
          http.get<{ data?: Array<RecordValue> }>(`/inventory/items?page=1&pageSize=1&id=${itemId}`, { service: 'asset', active: true }),
          http.get<{ data?: Array<RecordValue> }>(`/inventory/batches?inventoryItemId=${itemId}&page=1&pageSize=20`, { service: 'asset', active: true }),
        ]);
        setItem((itemResult.data ?? [])[0] ?? null);
        setBatches(batchResult.data ?? []);
      } catch (error) {
        feedback.error(error, '库存条目详情加载失败');
      }
    })();
  }, [itemId, feedback]);
  const items = item ? [
    { label: '品种', children: String(item.consumableName ?? '—') },
    { label: '库位', children: String(item.warehouseName ?? '—') },
    { label: '可用数量', children: String(item.availableQty ?? '—') },
    { label: '账面数量', children: String(item.bookQty ?? '—') },
    { label: '占用数量', children: String(item.reservedQty ?? '—') },
  ] : [];
  return <Drawer title="库存条目详情" open={itemId !== null} onClose={onClose} width="min(92vw, 720px)">
    {item ? <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Descriptions bordered column={1} size="small" items={items} />
      <Card size="small" title={`该条目批次（${batches.length}）`} extra={<Button size="small" onClick={() => navigate(`/asset/inventory-batches?inventoryItemId=${itemId}`)}>查看全部批次</Button>} styles={{ body: { padding: 0 } }}>
        <Table<RecordValue> size="small" rowKey={(row) => String(row.id)} pagination={false} dataSource={batches} locale={{ emptyText: '暂无批次' }} columns={[
          { key: 'spec', title: '规格', dataIndex: 'spec' },
          { key: 'remainingQty', title: '剩余数量', dataIndex: 'remainingQty' },
          { key: 'receivedAt', title: '入库时间', dataIndex: 'receivedAt' },
        ]} />
      </Card>
    </Space> : <Typography.Text>正在加载...</Typography.Text>}
  </Drawer>;
}

/** 库存批次页：支持从条目详情携带 inventoryItemId 进入并自动筛选。 */
function InventoryBatches() {
  const feedback = useFeedback();
  const [searchParams] = useSearchParams();
  const itemId = searchParams.get('inventoryItemId');
  const [version, setVersion] = useState(0);
  const [batchId, setBatchId] = useState<number | null>(null);
  const correctBatch = async (values: RecordValue) => {
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
  const endpoint = itemId ? `/inventory/batches?inventoryItemId=${itemId}` : '/inventory/batches';
  return <>
    <DataTable key={`batches-${version}`} title="库存批次" service="asset" endpoint={endpoint} pageKey="asset-inventory-batches" columns={[{ key: 'consumableName', title: '品种', sortable: true }, { key: 'spec', title: '规格', sortable: true }, { key: 'warehouseName', title: '库位', sortable: true }, { key: 'remainingQty', title: '剩余数量', sortable: true }, { key: 'supplierName', title: '供应商' }, { key: 'unitPrice', title: '单价' }, { key: 'receivedAt', title: '入库时间', sortable: true }]} filterFields={[{ key: 'inventoryItemId', title: '库存条目', type: 'remote', remote: inventoryItemsSource }, { key: 'consumableId', title: '品种', type: 'remote', remote: consumablesSource }, { key: 'warehouseId', title: '库位', type: 'tree', remote: warehouseTreeSource }]} rowActions={(row) => <Button size="small" onClick={() => setBatchId(Number(row.id))}>纠正批次</Button>} />
    <ResourceFormModal title="纠正库存批次" open={batchId !== null} onCancel={() => setBatchId(null)} onSubmit={correctBatch} fields={[{ key: 'reason', label: '纠正原因', type: 'textarea', required: true, maxLength: 500 }, { key: 'supplierId', label: '供应商', type: 'remote-select', remote: assetDictSource('SUPPLIER') }, { key: 'brandId', label: '品牌', type: 'remote-select', remote: assetDictSource('BRAND') }, { key: 'unitPrice', label: '单价（元）', type: 'number', width: 'narrow' }, { key: 'spec', label: '规格', maxLength: 100, width: 'wide' }, { key: 'warehouseId', label: '目标库位', type: 'tree-select', remote: warehouseTreeSource }, { key: 'remark', label: '批次备注', type: 'textarea', maxLength: 500 }]} />
  </>;
}

function StockFlows() {
  return (
    <DataTable
      title="库存流水"
      service="asset"
      endpoint="/inventory/stock-flows"
      pageKey="asset-stock-flows"
      columns={[
        { key: 'flowType', title: '类型', render: (value: unknown) => <StatusTag value={value} enumKind="stockFlowType" />, sortable: true },
        { key: 'consumableName', title: '品种', sortable: true },
        { key: 'qty', title: '数量', sortable: true },
        { key: 'warehouseName', title: '库位', sortable: true },
        { key: 'createdAt', title: '发生时间', sortable: true },
      ]}
      filterFields={[
        { key: 'consumableId', title: '品种', type: 'remote', remote: consumablesSource },
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
  const run = async (id: number, action: 'start' | 'cancel', body: RecordValue = {}) => {
    try {
      await http.post(`/repair-orders/${id}/${action}`, body, { service: 'asset' });
      feedback.success(action === 'start' ? '维修已开始' : '维修已取消');
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, action === 'start' ? '开始维修失败' : '取消维修失败');
    }
  };
  const complete = async (values: RecordValue) => {
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
    <ResourcePage key={version} title="维修管理" service="asset" endpoint="/repair-orders" pageKey="asset-repairs" columns={markSortable(REPAIR_COLUMNS, ['name', 'status', 'createdAt'])} filterFields={[{ key: 'status', title: '状态', type: 'enum', options: [{ label: '待维修', value: 'PENDING' }, { label: '维修中', value: 'REPAIRING' }, { label: '已取消', value: 'CANCELLED' }, { label: '已完成', value: 'COMPLETED' }] }, { key: 'assetId', title: '固定资产', type: 'remote', remote: assetsSource }]} create={{ title: '登记维修', endpoint: '/repair-orders', fields: [{ key: 'assetId', label: '固定资产', type: 'remote-select', remote: assetsSource, required: true, width: 'wide' }, { key: 'faultDescription', label: '故障/维修事项', type: 'textarea', required: true, maxLength: 1000 }] }} rowActions={(row) => <Space size="small">{row.status === 'PENDING' ? <><Popconfirm title="确认开始维修？" onConfirm={() => void run(Number(row.id), 'start')}><Button size="small">开始</Button></Popconfirm><Popconfirm title="确认取消维修登记？" onConfirm={() => void run(Number(row.id), 'cancel')}><Button size="small" danger>取消</Button></Popconfirm></> : null}{row.status === 'REPAIRING' ? <Button size="small" type="primary" onClick={() => setCompleteId(Number(row.id))}>完成维修</Button> : null}</Space>} />
    <ResourceFormModal title="完成维修" open={completeId !== null} onCancel={() => setCompleteId(null)} onSubmit={complete} fields={[{ key: 'result', label: '维修结果', type: 'textarea', required: true, maxLength: 1000 }, { key: 'actualCost', label: '实际费用', type: 'number', required: true, width: 'narrow' }, { key: 'postStatus', label: '恢复资产状态', type: 'select', required: true, options: [{ label: '闲置', value: 'IDLE' }, { label: '使用中', value: 'IN_USE' }], width: 'narrow' }]} />
  </>;
}

/** 我的借还：归还/核销提交审批；已结清记录禁用操作入口（批次 4-19）。 */
function MyBorrow() {
  const feedback = useFeedback();
  const [version, setVersion] = useState(0);
  const [returnId, setReturnId] = useState<number | null>(null);
  const [writeOffId, setWriteOffId] = useState<number | null>(null);
  const submitReturn = async (values: RecordValue) => {
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
  const submitWriteOff = async (values: RecordValue) => {
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
  return <>
    <DataTable key={version} title="我的借还" service="asset" endpoint="/my-borrow" pageKey="asset-my-borrow" columns={[{ key: 'consumableName', title: '资产/物品', sortable: true }, { key: 'qty', title: '借出数量', sortable: true }, { key: 'dueAt', title: '到期时间', sortable: true }, { key: 'returnedQty', title: '已归还' }, { key: 'writtenOffQty', title: '已核销' }]} filterFields={[{ key: 'settlementStatus', title: '结清状态', type: 'enum', options: [{ label: '未结清', value: 'OPEN' }, { label: '已结清', value: 'SETTLED' }] }]} rowActions={(row) => { const settled = row.settlementStatus === 'SETTLED'; return <Space size="small"><Button size="small" disabled={settled} onClick={() => setReturnId(Number(row.id))}>归还</Button><Button size="small" danger disabled={settled} onClick={() => setWriteOffId(Number(row.id))}>核销</Button></Space>; }} />
    <ResourceFormModal title="提交归还申请" open={returnId !== null} onCancel={() => setReturnId(null)} onSubmit={submitReturn} fields={[{ key: 'qty', label: '归还数量', type: 'number', required: true, width: 'narrow' }, { key: 'reason', label: '归还备注', type: 'textarea', maxLength: 200 }]} />
    <ResourceFormModal title="提交核销申请" open={writeOffId !== null} onCancel={() => setWriteOffId(null)} onSubmit={submitWriteOff} fields={[{ key: 'qty', label: '核销数量', type: 'number', required: true, width: 'narrow' }, { key: 'writeOffType', label: '核销类型', type: 'select', required: true, options: [{ label: '遗失', value: 'LOST' }, { label: '损坏', value: 'DAMAGED' }], width: 'narrow' }, { key: 'reason', label: '核销原因', type: 'textarea', required: true, maxLength: 500 }]} />
  </>;
}

/** 代领共享清单（受领人查看整张共享清单；归还与结清只能由代领发起人完成）。 */
function AgentSharedList() {
  return (
    <DataTable
      title="代领共享清单"
      service="asset"
      endpoint="/my-borrow?view=shared"
      pageKey="asset-borrow-shared"
      columns={[
        { key: 'proxyName', title: '代领人' },
        { key: 'consumableName', title: '物品' },
        { key: 'qty', title: '共享数量' },
        { key: 'dueAt', title: '到期时间' },
        { key: 'returnedQty', title: '已归还' },
        { key: 'writtenOffQty', title: '已核销' },
      ]}
    />
  );
}

/** 二维码管理专属页：卡片网格 + 查看/打印 + 停用/恢复/重新生成（asset PRD §11）。 */
function QrCodeManagement() {
  const feedback = useFeedback();
  const [createOpen, setCreateOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState<RecordValue | null>(null);
  const perform = async (id: number, action: 'DISABLE' | 'ENABLE' | 'REGENERATE') => {
    try {
      await http.post(`/qr-codes/${id}/action`, { action }, { service: 'asset' });
      feedback.success(action === 'REGENERATE' ? '二维码已重新生成' : action === 'DISABLE' ? '二维码已停用' : '二维码已恢复');
      setVersion((value) => value + 1);
    } catch (error) {
      feedback.error(error, '二维码操作失败');
    }
  };
  const columns: DataColumn[] = [
    {
      key: 'publicId',
      title: '二维码',
      width: 90,
      render: (value, row) => (typeof value === 'string' && value
        ? <QRCodeCanvas value={`${window.location.origin}/scan#${value}`} size={48} aria-label={`二维码 ${String(row.targetName ?? row.id)}`} />
        : '—'),
    },
    { key: 'targetName', title: '目标' },
    { key: 'targetType', title: '类型', enumKind: 'qrTargetType', sortable: true },
    { key: 'status', title: '状态', sortable: true, render: (value) => <StatusTag value={value} enumKind="qrStatus" /> },
    { key: 'createdAt', title: '创建时间', sortable: true, render: (value) => value ? formatBeijingDateTime(String(value)) : '—' },
  ];
  return <>
    <DataTable
      key={version}
      title="二维码管理"
      service="asset"
      endpoint="/qr-codes"
      pageKey="asset-qr-codes"
      columns={columns}
      filterFields={[
        { key: 'targetType', title: '目标类型', type: 'enum', options: [{ label: '固定资产', value: 'ASSET' }, { label: '库存条目', value: 'INVENTORY_ITEM' }, { label: '长期申领目录', value: 'SCAN_CATALOG' }] },
        { key: 'status', title: '状态', type: 'enum', options: [{ label: '有效', value: 'ACTIVE' }, { label: '已停用', value: 'DISABLED' }, { label: '已作废', value: 'REVOKED' }] },
      ]}
      actions={<Button type="primary" onClick={() => setCreateOpen(true)}>生成二维码</Button>}
      rowActions={(row) => {
        const status = String(row.status ?? '');
        const publicId = typeof row.publicId === 'string' ? row.publicId : '';
        return (
          <Space wrap>
            <Button size="small" onClick={() => setPreview(row)}>查看</Button>
            <PrintQrButton value={`${window.location.origin}/scan#${publicId}`} label={String(row.targetName ?? row.id ?? '')} />
            {status === 'ACTIVE' ? <Popconfirm title="确认停用二维码？" description="停用期间扫码无效，恢复后同一张二维码重新生效。" okText="停用" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void perform(Number(row.id), 'DISABLE')}><Button size="small" danger>停用</Button></Popconfirm> : null}
            {status === 'DISABLED' ? <Popconfirm title="确认恢复二维码？" onConfirm={() => void perform(Number(row.id), 'ENABLE')}><Button size="small">恢复</Button></Popconfirm> : null}
            <Popconfirm title="确认作废当前二维码并重新生成？" description="旧二维码永久失效，不能恢复；业务数据不受影响。" okText="重新生成" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void perform(Number(row.id), 'REGENERATE')}><Button size="small" danger>重新生成</Button></Popconfirm>
          </Space>
        );
      }}
    />
    <QrCreateModal
      open={createOpen}
      onCancel={() => setCreateOpen(false)}
      onSubmit={async (values) => {
        await http.post('/qr-codes', values, { service: 'asset' });
        feedback.success('二维码已生成');
        setCreateOpen(false);
        setVersion((value) => value + 1);
      }}
    />
    <Modal title="二维码" open={preview !== null} onCancel={() => setPreview(null)} footer={<Button onClick={() => setPreview(null)}>关闭</Button>}>
      {preview && typeof preview.publicId === 'string' ? <Space direction="vertical" size="middle" style={{ width: '100%', alignItems: 'center' }}>
        <Typography.Text strong>{String(preview.targetName ?? '—')}</Typography.Text>
        <QRCodeCanvas value={`${window.location.origin}/scan#${preview.publicId}`} size={200} />
        <PrintQrButton value={`${window.location.origin}/scan#${preview.publicId}`} label={String(preview.targetName ?? preview.id ?? '')} />
      </Space> : null}
    </Modal>
  </>;
}

/**
 * 生成二维码表单：按目标类型切换资产/库存选择器；申领目录无需目标。
 */
function QrCreateModal({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (values: RecordValue) => Promise<void>;
}) {
  const [form] = Form.useForm<RecordValue>();
  const [submitting, setSubmitting] = useState(false);
  const targetType = Form.useWatch('targetType', form) as string | undefined;
  useEffect(() => {
    if (open) {
      form.setFieldsValue({ targetType: 'ASSET', targetId: undefined });
    } else {
      form.resetFields();
    }
  }, [form, open]);
  return (
    <Modal title="生成二维码" open={open} onCancel={onCancel} footer={null} destroyOnHidden width="min(92vw, 420px)">
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          setSubmitting(true);
          void onSubmit({
            targetType: values.targetType,
            ...(values.targetType === 'SCAN_CATALOG' ? {} : { targetId: values.targetId }),
          }).finally(() => setSubmitting(false));
        }}
      >
        <Form.Item name="targetType" label="目标类型" rules={[{ required: true, message: '请选择目标类型' }]}>
          <Select
            options={[
              { label: '固定资产', value: 'ASSET' },
              { label: '库存条目', value: 'INVENTORY_ITEM' },
              { label: '申领目录', value: 'SCAN_CATALOG' },
            ]}
            onChange={() => form.setFieldValue('targetId', undefined)}
          />
        </Form.Item>
        {targetType === 'ASSET' ? (
          <Form.Item name="targetId" label="目标资产" rules={[{ required: true, message: '请选择目标资产' }]}>
            <RemoteSelect source={assetsSource} placeholder="搜索资产名称" />
          </Form.Item>
        ) : null}
        {targetType === 'INVENTORY_ITEM' ? (
          <Form.Item name="targetId" label="目标库存条目" rules={[{ required: true, message: '请选择库存条目' }]}>
            <RemoteSelect source={inventoryItemsSource} placeholder="搜索品种或库位" />
          </Form.Item>
        ) : null}
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" htmlType="submit" loading={submitting}>生成</Button>
        </Space>
      </Form>
    </Modal>
  );
}

/** 打印二维码：从 canvas 提取图片并打开打印窗口（asset PRD §11 重新展示和打印同一张有效二维码）。 */
function PrintQrButton({ value, label }: { value: string; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handlePrint = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    openQrPrintWindow(label, canvas.toDataURL('image/png'));
  };
  return <Space direction="vertical" size={4} style={{ alignItems: 'center' }}>
    <div style={{ display: 'none' }}><QRCodeCanvas value={value} size={240} ref={canvasRef} /></div>
    <ConfirmAction title="确认打印二维码？" description="将打开打印窗口输出当前二维码。" okText="打印" onConfirm={handlePrint}>
      <Button size="small">打印</Button>
    </ConfirmAction>
  </Space>;
}

/**
 * 将扫码 URL 的库存条目参数转换为申领表单默认值。
 *
 * @param rawInventoryItemId URL 查询参数中的库存条目 ID
 * @returns 合法条目的申领明细默认值（对象数组）；非法值返回 undefined
 */
export function buildScannedClaimInitialValues(rawInventoryItemId: string | null): Record<string, unknown> | undefined {
  const inventoryItemId = Number(rawInventoryItemId);
  if (!Number.isSafeInteger(inventoryItemId) || inventoryItemId <= 0) return undefined;
  return { items: [{ inventoryItemId, qty: 1, purpose: '' }] };
}

/** 代领申请：受领人排除本人。 */
function AgentClaims() {
  const { user } = useSession();
  const excludeSelf = user?.id != null ? [user.id] : undefined;
  return (
    <ResourcePage
      title="代领申请"
      service="asset"
      endpoint="/agent-requests/mine"
      pageKey="asset-agent-claims"
      columns={markSortable([...REQUEST_COLUMNS, { key: 'applicantName', title: '代领人' }, { key: 'recipientCount', title: '受领人数' }], ['status', 'submittedAt', 'applicantName'])}
      filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]}
      create={{
        title: '提交代领申请',
        endpoint: '/agent-requests',
        fields: [
          { key: 'items', label: '物品明细', type: 'detail-list', required: true, detailColumns: AGENT_CLAIM_ITEM_COLUMNS, detailMinRows: 1 },
          { key: 'recipientIds', label: '受领人', type: 'remote-multi-select', remote: agentRecipientsSource, required: true, excludeValues: excludeSelf },
        ],
      }}
    />
  );
}

/** 扫码进入的消耗品申领页：库存二维码会预填对应库存条目，避免目标在跳转时丢失。 */
function ClaimRequests() {
  const [searchParams] = useSearchParams();
  const rawInventoryItemId = searchParams.get('inventoryItemId');
  const initialValues = buildScannedClaimInitialValues(rawInventoryItemId);
  return <ResourcePage
    title="消耗品申领"
    service="asset"
    endpoint="/consumable-requests/mine"
    pageKey="asset-claims"
    columns={markSortable([...REQUEST_COLUMNS, { key: 'applicantName', title: '申请人' }], ['status', 'submittedAt', 'applicantName'])}
    filterFields={[{ key: 'status', title: '审批状态', type: 'enum', options: APPROVAL_STATUS_OPTIONS }]}
    create={{
      title: '提交申领',
      endpoint: '/consumable-requests',
      fields: [{ key: 'items', label: '申领明细', type: 'detail-list', required: true, detailColumns: CLAIM_ITEM_COLUMNS, detailMinRows: 1 }],
      initialValues,
    }}
  />;
}

function ApprovalPage() {
  return <ApprovalCenter title="资产审批中心" service="asset" pageKey="asset-approval" />;
}

const ASSET_SETTING_GROUPS: SystemSettingsGroup[] = [
  {
    id: 'basic',
    title: '基础参数',
    keys: ['asset.scan.entry.url', 'asset.quota.reset.day'],
  },
];

const ASSET_SETTING_LABELS: Readonly<Record<string, string>> = {
  'asset.scan.entry.url': '扫码入口地址',
  'asset.quota.reset.day': '申领上限重置日',
};

const ASSET_SETTING_PRESENTATIONS: Readonly<Record<string, SystemSettingPresentation>> = {
  'asset.scan.entry.url': {
    placeholder: 'https://example.com/scan',
    inputMode: 'url',
    required: false,
  },
  'asset.quota.reset.day': {
    unit: '日', min: 1, max: 28, integer: true,
  },
};

/** 系统设置书签：运行参数 / 资产分类 / 业务字典（分类与字典删除为两段式引用确认）。 */
function AssetConfig({ onMenuSaved }: { onMenuSaved: () => void }) {
  return <Card>
    <Tabs items={[
      { key: 'params', label: '系统设置', children: <SystemSettingsPage
        service="asset"
        endpoint="/asset-settings"
        groups={ASSET_SETTING_GROUPS}
        labels={ASSET_SETTING_LABELS}
        presentations={ASSET_SETTING_PRESENTATIONS}
        save={async (patches) => {
          const scanEntryUrl = String(patches['asset.scan.entry.url'] ?? '').trim();
          await http.put('/asset-settings', {
            ...(scanEntryUrl ? { scanEntryUrl } : {}),
            quotaResetDay: patches['asset.quota.reset.day'] as number | undefined,
          }, { service: 'asset' });
        }}
      /> },
      { key: 'menu', label: '菜单管理', children: <MenuManagementTab systemCode="ASSET" defaults={NAVIGATION} onSaved={onMenuSaved} /> },
      { key: 'categories', label: '资产分类', children: <ResourcePage title="资产分类" service="asset" endpoint="/categories" pageKey="asset-categories" columns={COMMON_COLUMNS} create={{ title: '新建分类', endpoint: '/categories', fields: [{ key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'parentId', label: '父分类', type: 'tree-select', remote: assetCategoryTreeSource, required: true }] }} edit={{ title: '编辑资产分类', endpoint: (id) => `/categories/${id}`, fields: [{ key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'sort', label: '排序', type: 'number', width: 'narrow' }, { key: 'status', label: '状态', type: 'select', required: true, options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }], width: 'narrow' }] }} batchDelete={{ endpoint: '/categories/batch', bodyKey: 'ids', previewEndpoint: '/categories/delete-preview', previewItem: (item) => ({ name: String(item.name ?? '—'), refs: `现存资产 ${String(item.assetCount ?? 0)} 个；消耗品品种 ${String(item.consumableCount ?? 0)} 个` }) }} /> },
      { key: 'dicts', label: '业务字典', children: <ResourcePage title="业务字典" service="asset" endpoint="/dict-items" pageKey="asset-dicts" columns={markSortable([...COMMON_COLUMNS, { key: 'dictType', title: '类型', enumKind: 'assetDictType' as const }], ['name', 'status', 'createdAt', 'dictType'])} create={{ title: '新建字典项', endpoint: '/dict-items', fields: [{ key: 'dictType', label: '字典类型', type: 'select', required: true, options: enumOptions('assetDictType') }, { key: 'name', label: '名称', required: true, maxLength: 100 }] }} edit={{ title: '编辑字典项', endpoint: (id) => `/dict-items/${id}`, fields: [{ key: 'name', label: '名称', required: true, maxLength: 100 }, { key: 'sort', label: '排序', type: 'number', width: 'narrow' }, { key: 'status', label: '状态', type: 'select', required: true, options: [{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }], width: 'narrow' }] }} batchDelete={{ endpoint: '/dict-items/batch', bodyKey: 'ids', previewEndpoint: '/dict-items/delete-preview', previewItem: (item) => ({ name: String(item.name ?? '—'), refs: `业务引用 ${String(item.referencedCount ?? 0)} 处` }) }} /> },
    ]} />
  </Card>;
}

/** 组装注销借还直接处置请求；每次点击生成新幂等键，网络重试由请求层调用方复用。 */
function disposalPayload(values: RecordValue): RecordValue {
  const disposalType = String(values.disposalType ?? '');
  const payload: RecordValue = { disposalType, idempotencyKey: crypto.randomUUID() };
  if (disposalType === 'AGENT_SETTLE') {
    payload.agentRequestId = values.agentRequestId;
    if (Array.isArray(values.agentItems)) payload.agentItems = values.agentItems;
  } else if (Array.isArray(values.items)) {
    payload.items = values.items.map((item) => ({
      ...(item as RecordValue),
      method: disposalType,
    }));
  }
  return payload;
}
