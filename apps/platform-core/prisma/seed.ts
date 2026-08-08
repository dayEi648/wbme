/**
 * 种子与初始化数据（实现规划 T1-5、主 PRD §3.1、backstage PRD §1 及子系统 PRD §1）。
 *
 * - 权限目录初始注册：systems / business_sections / functions 三层，幂等（存在即跳过）；
 * - 权限目录版本单行（permission_catalog_meta id=1）；
 * - 第一个超级管理员种子账号（待激活、无密码、无钉钉绑定），
 *   由部署参数提供姓名/手机号/性别；账号激活后初始化入口永久关闭（已存在则跳过）。
 *
 * 运行：`pnpm exec prisma db seed`（prisma.config.ts 配置了 seed 命令）。
 */
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { normalizePhoneInput } from '@wbme/contracts';
import { PrismaClient } from '../src/generated/prisma/client';

/** 功能权限目录定义（各子系统 PRD §1；编码为稳定功能编码，T3 权限系统使用） */
interface FeatureDef {
  code: string;
  name: string;
  /** 可选数据范围档位（SELF/DEPARTMENT/COMPANY 子集） */
  scopes: string[];
}

interface SectionDef {
  code: string;
  name: string;
  features: FeatureDef[];
}

interface SystemDef {
  code: string;
  name: string;
  /** 产品状态：backstage 恒 OPEN，其余默认 COMING_SOON 由管理员开放 */
  productStatus: 'OPEN' | 'COMING_SOON';
  sections: SectionDef[];
}

const PERMISSION_CATALOG: readonly SystemDef[] = [
  {
    code: 'BACKSTAGE',
    name: '管理后台',
    productStatus: 'OPEN',
    sections: [
      {
        code: 'user',
        name: '用户',
        features: [{ code: 'user_manage', name: '用户管理', scopes: ['COMPANY'] }],
      },
      {
        code: 'content',
        name: '内容',
        features: [
          { code: 'release_log_view', name: '更新日志查看', scopes: ['COMPANY'] },
          { code: 'announcement_manage', name: '系统公告管理', scopes: ['COMPANY'] },
        ],
      },
      {
        code: 'permission',
        name: '权限',
        features: [
          { code: 'system_structure_manage', name: '系统与业务结构管理', scopes: ['COMPANY'] },
          { code: 'operation_log_view', name: '操作日志', scopes: ['DEPARTMENT', 'COMPANY'] },
          { code: 'permission_manage', name: '权限管理', scopes: ['COMPANY'] },
        ],
      },
      {
        code: 'system',
        name: '系统',
        features: [
          { code: 'system_settings', name: '系统设置', scopes: ['COMPANY'] },
          { code: 'system_log_view', name: '系统日志', scopes: ['COMPANY'] },
          { code: 'data_backup', name: '数据备份', scopes: ['COMPANY'] },
          { code: 'health_status', name: '健康状态', scopes: ['COMPANY'] },
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
        features: [
          { code: 'my_assets', name: '我的资产', scopes: ['SELF'] },
          { code: 'fixed_asset_view', name: '固定资产查看', scopes: ['DEPARTMENT', 'COMPANY'] },
          { code: 'fixed_asset_maintain', name: '固定资产维护', scopes: ['DEPARTMENT', 'COMPANY'] },
        ],
      },
      {
        code: 'consumable',
        name: '消耗品',
        features: [
          { code: 'consumable_apply', name: '消耗品申领', scopes: ['SELF'] },
          { code: 'consumable_apply_history', name: '消耗品申领历史记录', scopes: ['DEPARTMENT', 'COMPANY'] },
          { code: 'proxy_apply', name: '代交申领', scopes: ['DEPARTMENT', 'COMPANY'] },
          { code: 'my_borrow', name: '我的借还', scopes: ['SELF'] },
          { code: 'borrow_history', name: '借还历史记录', scopes: ['DEPARTMENT', 'COMPANY'] },
          { code: 'inventory_manage', name: '消耗品库存管理', scopes: ['COMPANY'] },
          { code: 'stock_in_apply', name: '入库申请', scopes: ['SELF'] },
          { code: 'stock_in_history', name: '入库申请历史记录', scopes: ['DEPARTMENT', 'COMPANY'] },
          { code: 'stock_change_apply', name: '库存变更申请', scopes: ['SELF'] },
          { code: 'stock_change_history', name: '库存变更申请历史记录', scopes: ['DEPARTMENT', 'COMPANY'] },
        ],
      },
      {
        code: 'approval',
        name: '审批',
        features: [{ code: 'consumable_approval', name: '消耗品审批', scopes: ['DEPARTMENT', 'COMPANY'] }],
      },
      {
        code: 'config',
        name: '配置',
        features: [{ code: 'asset_config', name: '资产配置', scopes: ['COMPANY'] }],
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
        features: [
          { code: 'overtime_apply', name: '加班申请', scopes: ['SELF'] },
          { code: 'proxy_overtime', name: '代交加班', scopes: ['DEPARTMENT', 'COMPANY'] },
          { code: 'overtime_approval', name: '加班审批', scopes: ['DEPARTMENT', 'COMPANY'] },
          { code: 'overtime_history', name: '加班历史记录', scopes: ['DEPARTMENT', 'COMPANY'] },
        ],
      },
      {
        code: 'org',
        name: '组织',
        features: [
          { code: 'org_structure', name: '组织架构', scopes: ['COMPANY'] },
          { code: 'department_manage', name: '部门管理', scopes: ['COMPANY'] },
          { code: 'position_manage', name: '岗位管理', scopes: ['COMPANY'] },
          { code: 'title_manage', name: '职称管理', scopes: ['COMPANY'] },
        ],
      },
      {
        code: 'config',
        name: '配置',
        features: [{ code: 'hr_config', name: '人事配置', scopes: ['COMPANY'] }],
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
        features: [
          { code: 'finance_view', name: '财务数据查看', scopes: ['COMPANY'] },
          { code: 'finance_maintain', name: '财务数据维护', scopes: ['COMPANY'] },
        ],
      },
      {
        code: 'config',
        name: '配置',
        features: [{ code: 'finance_config', name: '财务配置', scopes: ['COMPANY'] }],
      },
    ],
  },
];

/** 幂等注册权限目录（主 PRD §3.1：系统 → 板块 → 功能三层） */
async function seedPermissionCatalog(prisma: PrismaClient): Promise<void> {
  for (const [systemIndex, system] of PERMISSION_CATALOG.entries()) {
    const systemRow = await prisma.system.upsert({
      where: { code: system.code },
      update: {},
      create: { code: system.code, name: system.name, productStatus: system.productStatus, sort: systemIndex },
    });
    for (const [sectionIndex, section] of system.sections.entries()) {
      const sectionRow = await prisma.businessSection.upsert({
        where: { systemId_code: { systemId: systemRow.id, code: section.code } },
        update: {},
        create: {
          systemId: systemRow.id,
          code: section.code,
          name: section.name,
          sort: sectionIndex,
        },
      });
      for (const [featureIndex, feature] of section.features.entries()) {
        await prisma.function.upsert({
          where: { code: feature.code },
          update: {},
          create: {
            systemId: systemRow.id,
            sectionId: sectionRow.id,
            code: feature.code,
            name: feature.name,
            dataScopeOptions: feature.scopes,
            sort: featureIndex,
          },
        });
      }
    }
  }
  // 权限目录版本单行（id=1；并发对账在 T3-1 递增版本）
  await prisma.permissionCatalogMeta.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, catalogVersion: 0 },
  });
  const systemCount = PERMISSION_CATALOG.length;
  const sectionCount = PERMISSION_CATALOG.reduce((n, s) => n + s.sections.length, 0);
  const featureCount = PERMISSION_CATALOG.reduce(
    (n, s) => n + s.sections.reduce((m, sec) => m + sec.features.length, 0),
    0,
  );
  console.log(`[seed] 权限目录注册完成（${systemCount} 系统 / ${sectionCount} 板块 / ${featureCount} 功能）`);
}

/** 幂等创建第一个超级管理员种子账号（待激活；激活后初始化入口永久关闭） */
async function seedSuperAdmin(prisma: PrismaClient): Promise<void> {
  const name = process.env.SUPER_ADMIN_NAME;
  const phone = process.env.SUPER_ADMIN_PHONE;
  const gender = process.env.SUPER_ADMIN_GENDER;
  if (!name || !phone || !gender) {
    console.log('[seed] 未配置 SUPER_ADMIN_NAME/PHONE/GENDER，跳过超级管理员种子（可稍后通过初始化命令创建）');
    return;
  }
  if (gender !== 'MALE' && gender !== 'FEMALE') {
    throw new Error('SUPER_ADMIN_GENDER 必须为 MALE 或 FEMALE');
  }
  // 手机号统一规范化为平台标准格式（+国家码+号码，base PRD §7.2）：
  // 与登录查询、唯一性校验口径一致，避免种子写入非规范化号码造成唯一性校验盲区
  const normalizedPhone = normalizePhoneInput(phone);
  if (!normalizedPhone) {
    throw new Error(`SUPER_ADMIN_PHONE 无法规范化为平台标准格式（应如 13800138000 / +8613800138000）：${phone}`);
  }
  const existing = await prisma.user.findFirst({
    where: { isSuperAdmin: true, deletedAt: null },
  });
  if (existing) {
    console.log(`[seed] 超级管理员已存在（id=${existing.id}），初始化入口永久关闭，跳过`);
    return;
  }
  const admin = await prisma.user.create({
    data: {
      name,
      phone: normalizedPhone,
      gender,
      status: 'PENDING_ACTIVATION',
      isSuperAdmin: true,
    },
  });
  console.log(`[seed] 超级管理员种子账号已创建（id=${admin.id}，待激活，姓名=${name}）`);
  console.log('[seed] 请管理员在用户管理中为该账号生成一次性激活邀请（M1 激活邀请接口已接入，管理页面随 T9-4 提供）');
}

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    await seedPermissionCatalog(prisma);
    await seedSuperAdmin(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('[seed] 初始化失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
