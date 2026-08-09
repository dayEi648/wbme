import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { FINANCE_CONFIG_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadFinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { SettingsService } from './settings.service';

/** 财务配置更新 DTO（MVP 无注册键，结构保留） */
export class FinSettingsUpdateDto {
  /** 设置键 */
  key!: string;
  /** 新值 */
  value!: string;
}

/**
 * 财务配置（fin PRD §6；F-7）。
 * 权限：fin 功能“财务配置”（finance_config，公司档）。
 * MVP 无固定运行参数：读取返回空列表，更新仅接受已注册键（当前为空集）。
 */
@Controller('finance-settings')
export class SettingsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** 读取全部财务配置 */
  @Get()
  async list(@CurrentUser() userId: number): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, FINANCE_CONFIG_FUNCTION_CODE);
    return this.settings.list();
  }

  /** 更新单条财务配置（未注册键拒绝） */
  @Put()
  async update(@CurrentUser() userId: number, @Body() dto: FinSettingsUpdateDto): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, FINANCE_CONFIG_FUNCTION_CODE);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.settings.update(dto.key, dto.value, operator.id);
  }
}
