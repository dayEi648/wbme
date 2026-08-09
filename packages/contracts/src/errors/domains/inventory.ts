import type { ErrorEntry } from '../types';

/** INVENTORY 域错误目录：消耗品库存、申领、借还（asset PRD §5–§8） */
export const inventoryErrors = {
  /** 库存不足：占用后不满足 `占用 ≤ 账面`（asset PRD §5） */
  INSUFFICIENT_STOCK: {
    code: 'INSUFFICIENT_STOCK',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '库存不足',
    detailsFields: ['currentStock', 'limit'],
  },
  /** 超出个人申领上限 / 同时持有上限（asset PRD §5） */
  INSUFFICIENT_QUOTA: {
    code: 'INSUFFICIENT_QUOTA',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '超出申领额度上限',
  },
  /** 库存/批次并发变化导致条件不再成立（asset PRD §6） */
  STOCK_CONFLICT: {
    code: 'STOCK_CONFLICT',
    type: 'CONFLICT',
    domain: 'INVENTORY',
    httpStatus: 409,
    message: '库存已变化，请刷新后重试',
  },
  /** 同一条目在整张清单中重复出现（asset PRD §5） */
  ITEM_DUPLICATED: {
    code: 'ITEM_DUPLICATED',
    type: 'VALIDATION',
    domain: 'INVENTORY',
    httpStatus: 400,
    message: '同一物品在清单中只能出现一次',
  },
  /** 品种存在当前账面/占用库存、未结清借还或待审批引用时拒绝删除（asset PRD §5） */
  CONSUMABLE_REFERENCED: {
    code: 'CONSUMABLE_REFERENCED',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '品种仍存在库存或业务引用，不允许删除',
  },
  /** 已有业务事实后品种单位不可修改（asset PRD §5） */
  UNIT_LOCKED: {
    code: 'UNIT_LOCKED',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '品种已产生业务事实，单位不可修改',
  },
  /** 批次规格纠正条件不满足（asset PRD §5） */
  BATCH_CORRECTION_FORBIDDEN: {
    code: 'BATCH_CORRECTION_FORBIDDEN',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '该批次存在后续流水或待审批占用，规格不可纠正',
  },
  /** 库位存在未删除子库位时禁止删除（asset PRD §5） */
  LOCATION_HAS_CHILDREN: {
    code: 'LOCATION_HAS_CHILDREN',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '存在未删除的子库位，请先处理',
  },
  /** 目标库位必须启用且不同于来源库位（asset PRD §6） */
  LOCATION_INVALID_TARGET: {
    code: 'LOCATION_INVALID_TARGET',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '目标库位不存在、已停用或与来源库位相同',
  },
  /** 品种已停用，不可用于新建入库/申领等（asset PRD §5） */
  CONSUMABLE_DISABLED: {
    code: 'CONSUMABLE_DISABLED',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '品种已停用',
  },
  /** 库位仍被现存库存条目、未结清借还或待审批引用，不允许删除（asset PRD §5） */
  LOCATION_REFERENCED: {
    code: 'LOCATION_REFERENCED',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '库位仍存在库存或业务引用，不允许删除',
  },
  /** 借还记录已结清，不可再发起归还/核销（asset PRD §8） */
  BORROW_ALREADY_SETTLED: {
    code: 'BORROW_ALREADY_SETTLED',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '借还记录已结清',
  },
  /** 代领结清未覆盖全部未结清数量（asset PRD §7） */
  SETTLEMENT_COVERAGE_INCOMPLETE: {
    code: 'SETTLEMENT_COVERAGE_INCOMPLETE',
    type: 'BUSINESS',
    domain: 'INVENTORY',
    httpStatus: 422,
    message: '结清清单必须覆盖全部未结清数量',
  },
  /** 注销员工直接处置前置条件不成立（账号已恢复/状态变化/数量超限）（asset PRD §8） */
  DISPOSAL_FORBIDDEN: {
    code: 'DISPOSAL_FORBIDDEN',
    type: 'CONFLICT',
    domain: 'INVENTORY',
    httpStatus: 409,
    message: '处置条件已变化，请刷新后重试',
  },
  /** 代领受领人名单非法（选择自己/重复/非在职）（asset PRD §7） */
  RECIPIENT_INVALID: {
    code: 'RECIPIENT_INVALID',
    type: 'VALIDATION',
    domain: 'INVENTORY',
    httpStatus: 400,
    message: '受领人名单无效',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
