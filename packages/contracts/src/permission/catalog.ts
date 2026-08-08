/**
 * 全平台功能权限目录权威定义（主 PRD §3.1、§2.5；功能清单：backstage/asset/hr/fin 各 PRD §1）。
 *
 * - 目录按「系统 → 业务板块 → 功能」三层组织，功能是唯一授权单位；
 *   BASE 功能全员可用，不进入目录。
 * - 本文件是全平台唯一权威来源：asset/hr/fin 的守卫与 backstage 的启动对账
 *   读取同一份定义，随全平台同一 Git commit 版本化，不允许各服务各自注册。
 * - 排序规则：系统/板块/功能的 sort 均取所在数组下标（0 起），与启动对账写入
 *   数据库的 sort 一致；调整数组顺序即调整排序（纯展示变化，不递增目录版本）。
 * - description 为功能的业务说明（授权界面悬停展示）：仅作为数据库初始值来源，
 *   管理员可在界面维护，启动对账不覆盖已入库的 description（主 PRD §3.1）。
 */
import type { DataScope, ProductStatus, SystemCode } from '../enums/common';

/** 目录功能定义（功能是唯一的授权单位） */
export interface CatalogFunctionDefinition {
  /** 稳定功能编码：全平台唯一，授权与守卫按编码引用，定义后不得改名（改名=移除+新增） */
  code: string;
  /** 功能名称（展示用，开发定义，界面不可调） */
  name: string;
  /** 业务说明（悬停展示该功能开放的业务操作；仅作数据库初始值，管理员可维护） */
  description: string;
  /** 可选数据范围档位（SELF/DEPARTMENT/COMPANY 子集，各 PRD §1「可选数据范围」列） */
  dataScopeOptions: readonly DataScope[];
}

/** 目录业务板块定义 */
export interface CatalogSectionDefinition {
  /** 板块编码：系统内唯一（开发定义） */
  code: string;
  /** 板块名称 */
  name: string;
  /** 板块业务说明（可选；仅作数据库初始值，管理员可维护，对账不覆盖） */
  description?: string;
  /** 板块内功能（数组下标即功能排序） */
  functions: readonly CatalogFunctionDefinition[];
}

/** 目录系统定义 */
export interface CatalogSystemDefinition {
  /** 系统编码（BACKSTAGE/ASSET/HR/FIN；BASE 不进入目录） */
  code: SystemCode;
  /** 系统名称 */
  name: string;
  /** 产品状态初始值：仅首次注册写入；之后由管理员在界面调整（backstage 恒 OPEN），对账不覆盖 */
  productStatus: ProductStatus;
  /** 系统内业务板块（数组下标即板块排序） */
  sections: readonly CatalogSectionDefinition[];
}

/**
 * 全平台功能权限目录。
 *
 * 内容逐项对应 backstage PRD §1（10 项）、asset PRD §1（15 项）、
 * hr PRD §1（9 项）、fin PRD §1（3 项）；变更本常量即变更授权语义，
 * platform-core 下次启动时对账入库并递增全局权限目录版本。
 */
export const PERMISSION_CATALOG: readonly CatalogSystemDefinition[] = [  {
    code: 'BACKSTAGE',
    name: '管理后台',
    productStatus: 'OPEN',
    sections: [
      {
        code: 'user',
        name: '用户',
        functions: [
          {
            code: 'user_manage',
            name: '用户管理',
            description: '用户创建、查询、编辑、批量注销/恢复、发起本人验证式密码重置、解锁账号、资料修改审批（管理员）',
            dataScopeOptions: ['COMPANY'],
          },
        ],
      },
      {
        code: 'content',
        name: '内容',
        functions: [
          {
            code: 'release_log_view',
            name: '更新日志查看',
            description: '只读查看每次成功部署自动追加的版本更新日志；与系统公告权限相互独立',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'announcement_manage',
            name: '系统公告管理',
            description: '创建、编辑、发布、撤回和批量删除系统公告；可读取更新日志并复制为公告内容来源',
            dataScopeOptions: ['COMPANY'],
          },
        ],
      },
      {
        code: 'permission',
        name: '权限',
        functions: [
          {
            code: 'system_structure_manage',
            name: '系统与业务结构管理',
            description: '系统状态、业务板块维护',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'operation_log_view',
            name: '操作日志',
            description: '全员操作日志查询（个人日志全员可用，不在此授权）',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
          {
            code: 'permission_manage',
            name: '权限管理',
            description: '管理全部系统内员工的功能授权与权限组；仅超级管理员可授予或撤销',
            dataScopeOptions: ['COMPANY'],
          },
        ],
      },
      {
        code: 'system',
        name: '系统',
        functions: [
          {
            code: 'system_settings',
            name: '系统设置',
            description: '平台级运行参数（平台配置；AI 配置随智能模块启用后提供）',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'system_log_view',
            name: '系统日志',
            description: '错误日志（运行异常聚合）与安全日志（认证与账号安全事件）',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'data_backup',
            name: '数据备份',
            description: '查看备份与执行立即备份；整库恢复仅超级管理员可执行',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'health_status',
            name: '健康状态',
            description: '查看服务就绪状态、依赖概况与后台任务状态数量，不查看统一任务明细',
            dataScopeOptions: ['COMPANY'],
          },
        ],
      },
    ],
  },
  {
    code: 'ASSET',
    name: '资产系统',
    productStatus: 'COMING_SOON',
    sections: [
      {
        code: 'fixed-asset',
        name: '资产台账',
        functions: [
          {
            code: 'my_assets',
            name: '我的资产',
            description: '查看责任人或使用者为本人的固定资产，按“我负责的 / 我使用的”筛选（员工）',
            dataScopeOptions: ['SELF'],
          },
          {
            code: 'fixed_asset_view',
            name: '固定资产查看',
            description: '范围内固定资产台账、详情、历史、二维码与导出（只读人员）',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
          {
            code: 'fixed_asset_maintain',
            name: '固定资产维护',
            description: '建档、编辑、调度、维修、变更、报废、二维码管理；隐含包含“固定资产查看”的全部能力（资产管理员）',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
        ],
      },
      {
        code: 'consumable',
        name: '消耗品',
        functions: [
          {
            code: 'consumable_apply',
            name: '消耗品申领',
            description: '提交申领清单、查看/取消本人清单（员工）；隐含本人申领历史',
            dataScopeOptions: ['SELF'],
          },
          {
            code: 'consumable_apply_history',
            name: '消耗品申领历史记录',
            description: '查看范围内的申领记录',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
          {
            code: 'proxy_apply',
            name: '代交申领',
            description: '为范围内在职员工代领物品：维护受领人名单与一张共享物品清单，创建/提交/跟踪/取消、代领一次性整单结清（发起人）',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
          {
            code: 'my_borrow',
            name: '我的借还',
            description: '本人借出、发起归还/核销申请、本人作为受领人的代领共享清单（只读且不计个人持有）；隐含本人借还历史',
            dataScopeOptions: ['SELF'],
          },
          {
            code: 'borrow_history',
            name: '借还历史记录',
            description: '按个人/代领记录类型、物品、借用人/代交人/受领人、部门、结清状态、逾期查询借还、归还、核销记录',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
          {
            code: 'inventory_manage',
            name: '消耗品库存管理',
            description: '品种、库位、库存、轻量库存调拨与流水维护（资产管理员）',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'stock_in_apply',
            name: '入库申请',
            description: '提交入库申请（员工）；隐含本人入库申请历史',
            dataScopeOptions: ['SELF'],
          },
          {
            code: 'stock_in_history',
            name: '入库申请历史记录',
            description: '查看范围内的入库申请记录',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
          {
            code: 'stock_change_apply',
            name: '库存变更申请',
            description: '提交库存变更申请（员工）；隐含本人变更申请历史',
            dataScopeOptions: ['SELF'],
          },
          {
            code: 'stock_change_history',
            name: '库存变更申请历史记录',
            description: '查看范围内的库存变更申请记录',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
        ],
      },
      {
        code: 'approval',
        name: '审批',
        functions: [
          {
            code: 'consumable_approval',
            name: '消耗品审批',
            description: '统一审批入库、库存变更、普通/代交申领、个人归还、个人遗失/损坏核销和代领整单结清；直接处理范围内已注销员工的个人借还及已注销代交人的共享清单结清（审批人）',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
        ],
      },
      {
        code: 'config',
        name: '配置',
        functions: [
          {
            code: 'asset_config',
            name: '资产配置',
            description: '运行参数与业务字典（资产管理员）',
            dataScopeOptions: ['COMPANY'],
          },
        ],
      },
    ],
  },
  {
    code: 'HR',
    name: '人事系统',
    productStatus: 'COMING_SOON',
    sections: [
      {
        code: 'overtime',
        name: '加班',
        functions: [
          {
            code: 'overtime_apply',
            name: '加班申请',
            description: '员工本人提交加班申请、本人记录与月度汇总（个人视图）、取消本人待审批批次；隐含本人加班历史',
            dataScopeOptions: ['SELF'],
          },
          {
            code: 'proxy_overtime',
            name: '代交加班',
            description: '为范围内员工代提交加班（项目负责人/代提人）',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
          {
            code: 'overtime_approval',
            name: '加班审批',
            description: '审批中心处理加班申请、已处理历史（审批人）',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
          {
            code: 'overtime_history',
            name: '加班历史记录',
            description: '员工记录、月度统计、下钻、导出（管理视图）',
            dataScopeOptions: ['DEPARTMENT', 'COMPANY'],
          },
        ],
      },
      {
        code: 'org',
        name: '组织',
        functions: [
          {
            code: 'org_structure',
            name: '组织架构',
            description: '用户部门/岗位编排、岗位申请审批（组织管理员）',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'department_manage',
            name: '部门管理',
            description: '部门树维护（组织管理员/行政）',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'position_manage',
            name: '岗位管理',
            description: '岗位档案维护（组织管理员）',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'title_manage',
            name: '职称管理',
            description: '职称匹配规则维护（组织管理员）',
            dataScopeOptions: ['COMPANY'],
          },
        ],
      },
      {
        code: 'config',
        name: '配置',
        functions: [
          {
            code: 'hr_config',
            name: '人事配置',
            description: '运行参数与人事字典（人事管理员）',
            dataScopeOptions: ['COMPANY'],
          },
        ],
      },
    ],
  },
  {
    code: 'FIN',
    name: '财务系统',
    productStatus: 'COMING_SOON',
    sections: [
      {
        code: 'contract-profit',
        name: '合同与利润',
        functions: [
          {
            code: 'finance_view',
            name: '财务数据查看',
            description: '项目、工程合同、利润分析与项目操作记录只读；仅利润分析页支持按指定模板导出（财务查看人员）',
            dataScopeOptions: ['COMPANY'],
          },
          {
            code: 'finance_maintain',
            name: '财务数据维护',
            description: '项目新建编辑、财务数据与明细维护、利润分析模板导入；隐含包含“财务数据查看”的全部能力（财务维护人员）',
            dataScopeOptions: ['COMPANY'],
          },
        ],
      },
      {
        code: 'config',
        name: '配置',
        functions: [
          {
            code: 'finance_config',
            name: '财务配置',
            description: '业务字典（含地区）（财务管理员）',
            dataScopeOptions: ['COMPANY'],
          },
        ],
      },
    ],
  },
];

/**
 * "权限管理"功能编码（backstage PRD §1 权限板块）：平台唯一授权管理功能。
 * 仅超级管理员可授予或撤销该功能；权限管理员不能授予/撤销任何人的该功能（主 PRD §3.1 委派规则）。
 */
export const PERMISSION_MANAGE_FUNCTION_CODE = 'permission_manage';

/**
 * "用户管理"功能编码（backstage PRD §1 用户板块）：用户创建/编辑/注销/恢复、
 * 激活邀请、管理员发起密码重置、解锁账号、资料修改审批（backstage PRD §3/§5）。
 */
export const USER_MANAGE_FUNCTION_CODE = 'user_manage';

/** 扁平化的目录功能条目：对账与守卫读取用（排序 = 各层数组下标） */
export interface CatalogFunctionEntry {
  /** 所属系统编码 */
  systemCode: SystemCode;
  /** 所属板块编码 */
  sectionCode: string;
  /** 功能定义 */
  definition: CatalogFunctionDefinition;
  /** 系统入口排序（目录数组下标，0 起） */
  systemSort: number;
  /** 板块排序（系统内数组下标，0 起） */
  sectionSort: number;
  /** 功能排序（板块内数组下标，0 起） */
  functionSort: number;
}

/**
 * 把三层目录扁平化为功能条目列表（携带归属与排序）。
 *
 * @param catalog 目录定义，默认全平台权威目录 PERMISSION_CATALOG
 * @returns 功能条目列表（目录数组顺序即排序）
 */
export function flattenPermissionCatalog(
  catalog: readonly CatalogSystemDefinition[] = PERMISSION_CATALOG,
): CatalogFunctionEntry[] {
  const entries: CatalogFunctionEntry[] = [];
  for (const [systemSort, system] of catalog.entries()) {
    for (const [sectionSort, section] of system.sections.entries()) {
      for (const [functionSort, definition] of section.functions.entries()) {
        entries.push({ systemCode: system.code, sectionCode: section.code, definition, systemSort, sectionSort, functionSort });
      }
    }
  }
  return entries;
}
