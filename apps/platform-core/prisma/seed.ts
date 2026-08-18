/**
 * 种子与初始化数据（主 PRD §3.1、backstage PRD §1 及子系统 PRD §1）。
 *
 * - 权限目录初始注册：复用启动对账逻辑（同一权威目录定义 @wbme/contracts
 *   的 PERMISSION_CATALOG），systems / business_sections / functions 三层 +
 *   权限目录版本单行（permission_catalog_meta id=1），幂等（全新库=首次注册）；
 * - 第一个超级管理员种子账号：部署参数提供姓名/手机号/性别/初始密码，
 *   直接创建为已激活账号（幂等：已存在已激活超管时跳过；历史遗留的
 *   待激活种子超管按部署参数激活并写入初始密码，其未使用邀请同步失效）。
 *   超管绑定钉钉在登录后于个人中心自助完成（base PRD §2）。
 *
 * 运行：`pnpm exec prisma db seed`（prisma.config.ts 配置了 seed 命令）。
 */
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { normalizePhoneInput } from '@wbme/contracts';
import { PrismaClient } from '../src/generated/prisma/client';
import { PasswordService } from '../src/modules/base/auth/password.service';
import { reconcilePermissionCatalog } from '../src/modules/backstage/permission-catalog/permission-catalog.reconcile';

/**
 * 权限目录初始注册（主 PRD §3.1：系统 → 板块 → 功能三层）。
 * 与 platform-core 启动对账共用同一实现，保证「全新库一条命令可起」与启动对账口径一致。
 */
async function seedPermissionCatalog(prisma: PrismaClient): Promise<void> {
  const report = await reconcilePermissionCatalog(prisma);
  console.log(
    `[seed] 权限目录对账完成（系统 +${report.systemsCreated} / 板块 +${report.sectionsCreated} / 功能 +${report.functionsCreated}，` +
      `移除功能 ${report.functionsRemoved}，目录版本=${report.catalogVersion}）`,
  );
}

/** 幂等创建第一个超级管理员种子账号（已激活、含初始密码；钉钉绑定由本人登录后自助完成） */
async function seedSuperAdmin(prisma: PrismaClient): Promise<void> {
  const name = process.env.SUPER_ADMIN_NAME;
  const phone = process.env.SUPER_ADMIN_PHONE;
  const gender = process.env.SUPER_ADMIN_GENDER;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!name || !phone || !gender || !password) {
    console.log('[seed] 未配置 SUPER_ADMIN_NAME/PHONE/GENDER/PASSWORD，跳过超级管理员种子（可稍后通过初始化命令创建）');
    return;
  }
  if (gender !== 'MALE' && gender !== 'FEMALE') {
    throw new Error('SUPER_ADMIN_GENDER 必须为 MALE 或 FEMALE');
  }
  const passwordService = new PasswordService();
  if (!passwordService.validatePolicy(password)) {
    throw new Error('SUPER_ADMIN_PASSWORD 需 8~32 个字符（base PRD §2 密码策略）');
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
    console.log(`[seed] 超级管理员已存在（id=${existing.id}），跳过`);
    return;
  }
  const passwordHash = await passwordService.hash(password);
  if (existing) {
    // 历史"待激活"种子账号（旧初始化流程遗留）：直接激活并写入初始密码，未使用邀请同步失效
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', passwordHash },
      });
      await tx.activationInvitation.updateMany({
        where: { userId: existing.id, status: 'VALID' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
    });
    console.log(`[seed] 历史待激活种子超管已激活（id=${existing.id}），初始密码以部署参数 SUPER_ADMIN_PASSWORD 为准`);
    return;
  }
  const admin = await prisma.user.create({
    data: {
      name,
      phone: normalizedPhone,
      gender,
      status: 'ACTIVE',
      isSuperAdmin: true,
      passwordHash,
    },
  });
  console.log(`[seed] 超级管理员种子账号已创建（id=${admin.id}，姓名=${name}），初始密码以部署参数 SUPER_ADMIN_PASSWORD 为准`);
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
