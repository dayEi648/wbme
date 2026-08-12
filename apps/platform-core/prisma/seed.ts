/**
 * 种子与初始化数据（主 PRD §3.1、backstage PRD §1 及子系统 PRD §1）。
 *
 * - 权限目录初始注册：复用启动对账逻辑（同一权威目录定义 @wbme/contracts
 *   的 PERMISSION_CATALOG），systems / business_sections / functions 三层 +
 *   权限目录版本单行（permission_catalog_meta id=1），幂等（全新库=首次注册）；
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
import QRCode from 'qrcode';
import { PrismaClient } from '../src/generated/prisma/client';
import { reconcilePermissionCatalog } from '../src/modules/backstage/permission-catalog/permission-catalog.reconcile';

/** 激活邀请默认有效期（秒）：与系统设置键 INVITATION_VALID_SECONDS 默认值一致（种子阶段不读设置表） */
const INVITATION_VALID_SECONDS = 604800;

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
  // 故由种子直接签发并打印链接（初始化命令一次性展示激活链接，不写日志）。
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
  const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:45173';
  const activationUrl = `${origin}/activate#${rawToken}`;
  console.log(`[seed] 超级管理员激活链接（一次性，${INVITATION_VALID_SECONDS / 86400} 天有效，仅本次展示）：${activationUrl}`);
  // 终端二维码（与链接同一凭证；链接与二维码两种交付方式，仅 stdout 一次性展示）
  console.log('[seed] 激活二维码（扫码打开同一链接）：');
  console.log(await QRCode.toString(activationUrl, { type: 'terminal', small: true }));
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
