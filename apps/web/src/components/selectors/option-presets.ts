import type { RemoteOptionSource, SelectOption } from './remote-options';

/** 平台已注销用户（恢复选择器）。 */
export const deactivatedUsersSource: RemoteOptionSource = {
  service: 'platform',
  endpoint: '/users?status=DEACTIVATED',
  labelKey: 'name',
  valueKey: 'id',
  secondaryKey: 'phone',
};

/** 权限管理可见的在职/待激活员工。 */
export const permissionEmployeesSource: RemoteOptionSource = {
  service: 'platform',
  endpoint: '/permission/employees',
  labelKey: 'name',
  valueKey: 'id',
  secondaryKey: 'phoneMasked',
};

/** 权限组列表。 */
export const permissionGroupsSource: RemoteOptionSource = {
  service: 'platform',
  endpoint: '/permission/groups',
  labelKey: 'name',
  valueKey: 'id',
};

/** HR 在职员工。 */
export const hrActiveEmployeesSource: RemoteOptionSource = {
  service: 'hr',
  endpoint: '/org/employees?status=ACTIVE',
  labelKey: 'name',
  valueKey: 'id',
};

/** 部门负责人可选在职员工（部门管理权限专用，避免依赖组织架构权限）。 */
export const departmentLeaderEmployeesSource: RemoteOptionSource = {
  service: 'hr',
  endpoint: '/departments/leader-options',
  labelKey: 'name',
  valueKey: 'id',
};

/** 加班申请可选员工，服务端按本人/代交范围裁剪。 */
export const overtimeEmployeesSource: RemoteOptionSource = {
  service: 'hr',
  endpoint: '/overtime/employee-options',
  labelKey: 'name',
  valueKey: 'id',
};

/** 固定资产维护范围内的部门树。 */
export const assetMaintainDepartmentsSource: RemoteOptionSource = {
  service: 'hr',
  endpoint: '/departments/asset-options',
  tree: true,
  activeOnly: true,
};

/** 固定资产维护范围内的在职员工；可由所属部门级联。 */
export const assetMaintainEmployeesSource: RemoteOptionSource = {
  service: 'hr',
  endpoint: '/org/asset-options',
  resolveEndpoint: (context) => {
    if (context === undefined || context === null || context === '') return '/org/asset-options';
    const departmentId = toPositiveId(context);
    return departmentId === null ? null : `/org/asset-options?departmentId=${departmentId}`;
  },
  labelKey: 'name',
  valueKey: 'id',
};

/** 部门树（扁平 parentId）。 */
export const departmentTreeSource: RemoteOptionSource = {
  service: 'hr',
  endpoint: '/departments/tree',
  tree: true,
  activeOnly: true,
};

/** 岗位列表（启用）。 */
export const positionsSource: RemoteOptionSource = {
  service: 'hr',
  endpoint: '/positions',
  labelKey: 'name',
  valueKey: 'id',
  activeOnly: true,
};

/** 资产分类树。 */
export const assetCategoryTreeSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/categories?status=ACTIVE',
  tree: true,
  activeOnly: true,
};

/** 库位嵌套树。 */
export const warehouseTreeSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/warehouses/tree?status=ACTIVE',
  nestedTree: true,
  activeOnly: true,
};

/** 入库申请可选库位（读取权限随入库申请，非库存管理）。 */
export const stockInWarehouseTreeSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/warehouses/stock-in-tree',
  nestedTree: true,
  activeOnly: true,
};

/** 消耗品品种。 */
export const consumablesSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/consumables?status=ACTIVE',
  labelKey: 'name',
  valueKey: 'id',
};

/** 入库申请可选启用品种。 */
export const stockInConsumablesSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/consumables/stock-in-options',
  labelKey: 'name',
  valueKey: 'id',
};

/** 库存条目（展示品种+库位）。 */
export const inventoryItemsSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/inventory/items',
  mapOption: (row) => {
    const id = row.id;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const name = String(row.consumableName ?? id);
    const warehouse = row.warehouseName != null ? String(row.warehouseName) : '';
    const available = row.availableQty != null ? `可用 ${String(row.availableQty)}` : '';
    const parts = [name, warehouse, available].filter(Boolean);
    return { label: parts.join(' · '), value: id, searchText: parts.join(' ') };
  },
};

/** 普通申领可选库存条目。 */
export const claimInventoryItemsSource: RemoteOptionSource = inventoryItemOptionsSource('/inventory/items/claim-options');

/** 代交申领可选库存条目。 */
export const agentClaimInventoryItemsSource: RemoteOptionSource = inventoryItemOptionsSource('/inventory/items/agent-claim-options');

/** 库存变更可选库存条目。 */
export const stockChangeInventoryItemsSource: RemoteOptionSource = inventoryItemOptionsSource('/inventory/items/stock-change-options');

/** 固定资产台账。 */
export const assetsSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/assets',
  labelKey: 'name',
  valueKey: 'id',
};

/** 资产字典项。 */
export function assetDictSource(dictType: 'UNIT' | 'CHANGE_TYPE' | 'SUPPLIER' | 'BRAND'): RemoteOptionSource {
  return {
    service: 'asset',
    endpoint: `/dict-items?dictType=${dictType}&status=ACTIVE`,
    labelKey: 'name',
    valueKey: 'id',
  };
}

/** 入库表单可选供应商/品牌，权限随入库申请。 */
export function stockInDictSource(dictType: 'SUPPLIER' | 'BRAND'): RemoteOptionSource {
  return {
    service: 'asset',
    endpoint: `/dict-items/stock-in-options?dictType=${dictType}`,
    labelKey: 'name',
    valueKey: 'id',
  };
}

/** 库存变更表单可选变更类型，权限随库存变更申请。 */
export const stockChangeTypeSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/dict-items/stock-change-options',
  labelKey: 'name',
  valueKey: 'id',
};

/** 本人代领申请（结清引用）。 */
export const myAgentRequestsSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/agent-requests/mine?status=APPROVED',
  mapOption: (row) => {
    const id = row.id;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const no = row.applicationNo != null ? String(row.applicationNo) : `#${id}`;
    const submitted = row.submittedAt != null ? String(row.submittedAt).slice(0, 10) : '';
    return { label: submitted ? `${no}（${submitted}）` : no, value: id };
  },
};

/** 当前用户有权代交的受领人，服务端按数据范围裁剪。 */
export const agentRecipientsSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/agent-requests/recipient-options',
  labelKey: 'name',
  valueKey: 'id',
};

/** 本人指定代领申请的未结清记录。 */
export const ownAgentOpenBorrowRecordsSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/agent-settlements/open-borrow-records',
  resolveEndpoint: (context) => {
    const refRequestId = toPositiveId(context);
    return refRequestId === null ? null : `/agent-settlements/open-borrow-records?refRequestId=${refRequestId}`;
  },
  mapOption: mapBorrowRecordOption,
};

/** 待处置借还记录（个人）。 */
export const pendingDisposalRecordsSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/disposals?tab=PENDING',
  mapOption: (row) => {
    const id = row.recordId ?? row.id;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const user = row.userName != null ? String(row.userName) : '';
    const item = row.consumableName != null ? String(row.consumableName) : '';
    const qty = row.qty != null ? `×${String(row.qty)}` : '';
    return { label: [user, item, qty].filter(Boolean).join(' · ') || String(id), value: id };
  },
};

/** 待处置个人借还记录（仅消耗品审批人已授权范围内的 PERSONAL 记录）。 */
export const pendingPersonalDisposalRecordsSource: RemoteOptionSource = {
  ...pendingDisposalRecordsSource,
  endpoint: '/disposals?tab=PENDING&recordType=PERSONAL',
};

/** 待处置代领申请（由其待处置共享借还记录去重得到）。 */
export const pendingAgentDisposalRequestsSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/disposals?tab=PENDING&recordType=AGENT',
  uniqueByValue: true,
  mapOption: (row) => {
    const id = row.agentRequestId;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const item = row.consumableName != null ? String(row.consumableName) : '';
    const qty = row.qty != null ? `×${String(row.qty)}` : '';
    return { label: [`代领申请 #${id}`, item, qty].filter(Boolean).join(' · '), value: id };
  },
};

/** 指定待处置代领申请的共享借还记录（来源已由消耗品审批范围服务端裁剪）。 */
export const pendingAgentDisposalRecordsSource: RemoteOptionSource = {
  service: 'asset',
  endpoint: '/disposals?tab=PENDING&recordType=AGENT',
  resolveEndpoint: (context) => {
    const agentRequestId = toPositiveId(context);
    return agentRequestId === null
      ? null
      : `/disposals?tab=PENDING&recordType=AGENT&agentRequestId=${agentRequestId}`;
  },
  mapOption: mapBorrowRecordOption,
};

/** 构造带统一展示字段的库存条目数据源。 */
function inventoryItemOptionsSource(endpoint: string): RemoteOptionSource {
  return {
    service: 'asset',
    endpoint,
    mapOption: (row) => {
      const id = row.id;
      if (typeof id !== 'string' && typeof id !== 'number') return null;
      const name = String(row.consumableName ?? id);
      const warehouse = row.warehouseName != null ? String(row.warehouseName) : '';
      const available = row.availableQty != null ? `可用 ${String(row.availableQty)}` : '';
      const parts = [name, warehouse, available].filter(Boolean);
      return { label: parts.join(' · '), value: id, searchText: parts.join(' ') };
    },
  };
}

/** 将借还记录映射为可搜索的“物品 + 规格 + 库位 + 数量”选项。 */
function mapBorrowRecordOption(row: Record<string, unknown>): SelectOption | null {
  const id = row.recordId ?? row.id;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  const item = row.consumableName != null ? String(row.consumableName) : '';
  const spec = row.spec != null ? String(row.spec) : '';
  const warehouse = row.warehouseName != null ? String(row.warehouseName) : '';
  const qty = row.qty != null ? `×${String(row.qty)}` : '';
  const parts = [item, spec, warehouse, qty].filter(Boolean);
  return { label: parts.join(' · ') || String(id), value: id, searchText: parts.join(' ') };
}

/** 仅接受安全正整数作为动态 URL 参数。 */
function toPositiveId(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** 财务字典。 */
export function financeDictSource(dictType: 'PROGRESS' | 'COMPLETENESS' | 'BIZ_CATEGORY' | 'REGION'): RemoteOptionSource {
  return {
    service: 'fin',
    endpoint: `/finance-dict-items?dictType=${dictType}&status=ACTIVE`,
    labelKey: 'name',
    valueKey: 'id',
  };
}

/** 工程合同项目列表（操作记录筛选）。 */
export const finProjectsSource: RemoteOptionSource = {
  service: 'fin',
  endpoint: '/projects',
  labelKey: 'name',
  valueKey: 'id',
};
