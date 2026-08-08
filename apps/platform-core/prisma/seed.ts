/**
 * 种子与初始化数据（实现规划 T1-5、主 PRD §3.1、backstage PRD §1 及子系统 PRD §1）。
 *
 * - 权限目录初始注册：systems / business_sections / functions 三层，幂等（存在即跳过）；
 * - 权限目录版本单行（permission_catalog_meta id=1）；
 * - 第一个超级管理员种子账号（待激活、无密码、无钉钉绑定），
 *   由部署参数提供姓名/手机号/性别；种子直接签发一次性激活邀请并打印链接
 *   （账号激活后初始化入口永久关闭；仍待激活时重跑 seed 重新签发并打印新链接）。
 *
 * 运行：`pnpm exec prisma db seed`（prisma.config.ts 配置了 seed 命令）。
 */
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { normalizePhoneInput } from '@wbme/contracts';
import { PrismaClient } from '../src/generated/prisma/client';

/** 激活邀请默认有效期（秒）：与系统设置键 INVITATION_VALID_SECONDS 默认值一致（种子阶段不读设置表） */
const INVITATION_VALID_SECONDS = 604800;

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
  if (existing?.status === 'ACTIVE') {
    console.log(`[seed] 超级管理员已激活（id=${existing.id}），初始化入口永久关闭，跳过`);
    return;
  }
  // 不存在或仍待激活（含激活链接丢失需重取的场景）：创建账号（幂等）并签发一次性激活邀请。
  // 激活邀请生成（M1）要求已认证的用户管理权限，而种子超管是待激活状态无法登录，
  // 故由种子直接签发并打印链接（T1-5 验收：初始化命令一次性展示激活链接，不写日志）。
  const admin =
    existing ??
    (await prisma.user.create({
      data: {
        name,
        phone: normalizedPhone,
        gender,
        status: 'PENDING_ACTIVATION',
        isSuperAdmin: true,
      },
    }));
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.$transaction(async (tx) => {
    // 重新签发：旧有效邀请立即失效（条件更新 + 部分唯一索引 (user_id) WHERE status='VALID' 并发安全）
    await tx.activationInvitation.updateMany({
      where: { userId: admin.id, status: 'VALID' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await tx.activationInvitation.create({
      data: {
        userId: admin.id,
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() + INVITATION_VALID_SECONDS * 1000),
        createdBy: null, // 部署初始化（表设计 B-2：创建者=初始化=NULL）
      },
    });
  });
  // 凭证放 URL fragment（base PRD §2：不得放 path/query）；打印到 stdout 仅展示给部署者，不写日志
  const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173';
  console.log(`[seed] 超级管理员激活链接（一次性，${INVITATION_VALID_SECONDS / 86400} 天有效，仅本次展示）：${origin}/activate#${rawToken}`);
  console.log('[seed] 账号激活后初始化入口永久关闭；链接丢失可重跑 seed 重新生成（旧链接立即失效）');
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
