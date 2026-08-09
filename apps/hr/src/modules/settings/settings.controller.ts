import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { HR_CONFIG_FUNCTION_CODE, HrSettingUpdateDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { SettingsService } from './settings.service';

/**
 * 人事配置（hr PRD §9）：运行参数读写；改参数即时生效（快照规则不追溯）。
 * 权限：hr 功能"人事配置"（hr_config，公司档）——服务内断言。
 */
@Controller('hr-settings')
export class SettingsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** 读取全部人事设置 */
  @Get()
  async list(@CurrentUser() userId: number): Promise<{ items: unknown[] }> {
    await assertFunctionAccess(this.prisma.client, userId, HR_CONFIG_FUNCTION_CODE);
    return this.settings.list();
  }

  /** 更新单条人事设置（写操作日志，变更可追溯操作者） */
  @Put(':key')
  async update(
    @CurrentUser() userId: number,
    @Param('key') key: string,
    @Body() dto: HrSettingUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, HR_CONFIG_FUNCTION_CODE);
    const result = await this.settings.update(key, dto.value, userId);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    await this.prisma.client.hrOperationLog.create({
      data: {
        operatorId: operator.id,
        operatorName: operator.name,
        operatorDepartments: operator.departments as object,
        system: 'HR',
        feature: HR_CONFIG_FUNCTION_CODE,
        actionType: 'UPDATE',
        summary: `更新了人事设置：${key} = ${dto.value}`,
      },
    });
    return result;
  }
}
