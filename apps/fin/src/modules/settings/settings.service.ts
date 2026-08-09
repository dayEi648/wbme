import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';

/**
 * 财务配置服务（fin PRD §6；F-7，结构与 backstage S-8 一致）。
 *
 * MVP 无固定运行参数（机制保留）：无注册键，读取返回空列表，
 * 更新只接受已注册键（当前为空集），未知键返回校验失败。
 */
@Injectable()
export class SettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 读取全部财务配置（当前无注册参数，返回空列表；机制保留）。
   *
   * @returns 设置项列表
   */
  async list(): Promise<{ items: unknown[] }> {
    const rows = await this.prisma.client.financeSetting.findMany({ orderBy: { key: 'asc' } });
    return { items: rows };
  }

  /**
   * 更新财务配置（只接受已注册键；MVP 无注册键，任意键均拒绝）。
   *
   * @param key 设置键
   * @param value 新值
   * @param updatedBy 操作人
   * @throws VALIDATION_FAILED 键未注册
   */
  async update(_key: string, _value: string, _updatedBy: number): Promise<{ ok: true }> {
    // F-7：MVP 无固定运行参数，机制保留；未知键统一拒绝（避免制造无定义参数）
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
      fields: [{ field: 'key', reason: '未知的财务设置键' }],
    });
  }
}
