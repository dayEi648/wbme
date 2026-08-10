import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
  FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
  INVENTORY_MANAGE_FUNCTION_CODE,
  QrActionDto,
  QrCodeCreateDto,
  QrCodeQueryDto,
  QrParseDto,
} from '@wbme/contracts';
import { CurrentUser, RateLimit, RateLimitGuard } from '@wbme/server';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import { getFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { QrService } from './qr.service';

/**
 * 二维码（asset PRD §11；A-27）。
 * 管理权限：固定资产二维码归「固定资产维护」（fixed_asset_maintain）；
 * 库存条目二维码与长期申领目录二维码归「消耗品库存管理」（inventory_manage）；
 * 解析接口登录即可（目标权限/状态由服务端校验），限流防枚举。
 */
@Controller('qr-codes')
export class QrController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly qr: QrService,
  ) {}

  /** 创建二维码（目标类型决定归属权限） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: QrCodeCreateDto): Promise<{ id: number; publicId: string }> {
    const functionCode = dto.targetType === 'ASSET' ? FIXED_ASSET_MAINTAIN_FUNCTION_CODE : INVENTORY_MANAGE_FUNCTION_CODE;
    await this.assertAnyAccess(userId, functionCode);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.qr.create(operator, dto);
  }

  /** 二维码列表（按用户管理权限过滤目标类型：资产→固定资产维护，库存/目录→消耗品库存管理） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: QrCodeQueryDto): Promise<{ items: unknown[]; total: number }> {
    const allowed = await this.visibleTargetTypes(userId);
    if (allowed.length === 0) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    return this.qr.list(userId, query, allowed);
  }

  /** 二维码管理动作（停用 / 恢复 / 作废并重新生成） */
  @Post(':id/action')
  async action(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: QrActionDto,
  ): Promise<{ ok: true; regenerated?: { id: number; publicId: string } }> {
    await this.assertAnyAccess(userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.qr.action(operator, id, dto.action, dto.idempotencyKey);
  }

  /**
   * 扫码解析（限流：IP + 用户双维度；失败不泄露目标内部详情；
   * 公开标识经 /scan#<publicId> fragment 提交，服务端日志不记录完整标识）。
   */
  @Post('parse')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'qr-parse', keyType: 'ip', limit: 60, windowSeconds: 60 })
  @RateLimit({ scope: 'qr-parse', keyType: 'user', limit: 120, windowSeconds: 60 })
  async parse(@CurrentUser() userId: number, @Body() dto: QrParseDto): Promise<unknown> {
    return this.qr.parse(userId, dto.publicId);
  }

  /** 任一功能授权即放行（未注册/未授权 → 404 不泄露存在性） */
  private async assertAnyAccess(userId: number, ...functionCodes: string[]): Promise<void> {
    for (const functionCode of functionCodes) {
      const access = await getFunctionAccess(this.prisma.client, userId, functionCode);
      if (access.registered && access.allowed) {
        return;
      }
    }
    throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
  }

  /** 用户可见的目标类型白名单（按 PRD §11 管理归属逐类校验权限） */
  private async visibleTargetTypes(userId: number): Promise<Array<'ASSET' | 'INVENTORY_ITEM' | 'SCAN_CATALOG'>> {
    const visible: Array<'ASSET' | 'INVENTORY_ITEM' | 'SCAN_CATALOG'> = [];
    const assetAccess = await getFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    if (assetAccess.registered && assetAccess.allowed) {
      visible.push('ASSET');
    }
    const inventoryAccess = await getFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    if (inventoryAccess.registered && inventoryAccess.allowed) {
      visible.push('INVENTORY_ITEM', 'SCAN_CATALOG');
    }
    return visible;
  }
}
