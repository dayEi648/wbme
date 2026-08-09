import { Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors, ColumnSettingDto, FilterPresetDto, RenameFilterPresetDto } from '@wbme/contracts';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';

/**
 * 用户表格偏好服务（A-30 同构于 B-5/H-18，账号维度读写，不写操作日志）。
 */
@Injectable()
export class TablePrefsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 列出当前用户某页的筛选预设 */
  async listFilterPresets(userId: number, pageKey: string): Promise<unknown> {
    const items = await this.prisma.client.assetUserTablePref.findMany({
      where: { userId, pageKey, prefType: 'FILTER_PRESET' },
      orderBy: { updatedAt: 'desc' },
    });
    return { items };
  }

  /** 获取列设置（每页最多一条） */
  async getColumnSetting(userId: number, pageKey: string): Promise<unknown> {
    const row = await this.prisma.client.assetUserTablePref.findFirst({
      where: { userId, pageKey, prefType: 'COLUMN_SETTING' },
    });
    return { item: row };
  }

  /** 创建筛选预设 */
  async createFilterPreset(userId: number, pageKey: string, dto: FilterPresetDto): Promise<unknown> {
    try {
      const row = await this.prisma.client.assetUserTablePref.create({
        data: {
          userId,
          pageKey,
          prefType: 'FILTER_PRESET',
          name: dto.name,
          content: dto.content as Prisma.InputJsonValue,
        },
      });
      return { id: row.id };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '同名筛选预设已存在' });
      }
      throw error;
    }
  }

  /** 更新筛选预设内容 */
  async updateFilterPreset(userId: number, id: number, dto: FilterPresetDto): Promise<unknown> {
    const existing = await this.prisma.client.assetUserTablePref.findFirst({
      where: { id, userId, prefType: 'FILTER_PRESET' },
    });
    if (!existing) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    await this.prisma.client.assetUserTablePref.update({
      where: { id },
      data: { content: dto.content as Prisma.InputJsonValue },
    });
    return { ok: true };
  }

  /** 重命名筛选预设（物理更新 name，唯一约束校验） */
  async renameFilterPreset(userId: number, id: number, dto: RenameFilterPresetDto): Promise<unknown> {
    const existing = await this.prisma.client.assetUserTablePref.findFirst({
      where: { id, userId, prefType: 'FILTER_PRESET' },
    });
    if (!existing) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    try {
      await this.prisma.client.assetUserTablePref.update({
        where: { id },
        data: { name: dto.name },
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '同名筛选预设已存在' });
      }
      throw error;
    }
  }

  /** 物理删除筛选预设 */
  async deleteFilterPreset(userId: number, id: number): Promise<unknown> {
    const existing = await this.prisma.client.assetUserTablePref.findFirst({
      where: { id, userId, prefType: 'FILTER_PRESET' },
    });
    if (!existing) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    await this.prisma.client.assetUserTablePref.delete({ where: { id } });
    return { ok: true };
  }

  /** 保存列设置（upsert） */
  async upsertColumnSetting(userId: number, pageKey: string, dto: ColumnSettingDto): Promise<unknown> {
    const existing = await this.prisma.client.assetUserTablePref.findFirst({
      where: { userId, pageKey, prefType: 'COLUMN_SETTING' },
    });
    if (existing) {
      await this.prisma.client.assetUserTablePref.update({
        where: { id: existing.id },
        data: { content: dto.content as Prisma.InputJsonValue },
      });
      return { id: existing.id };
    }
    const row = await this.prisma.client.assetUserTablePref.create({
      data: {
        userId,
        pageKey,
        prefType: 'COLUMN_SETTING',
        content: dto.content as Prisma.InputJsonValue,
      },
    });
    return { id: row.id };
  }
}
