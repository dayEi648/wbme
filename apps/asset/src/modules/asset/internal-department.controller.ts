import { Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AllowedCallers, InternalAuthGuard, Public } from '@wbme/server';
import { PrismaService } from '../../prisma.service';

/**
 * 部门资产归属内部接口（主 PRD §9.4，M12）。
 * 供 hr 部门删除预览/删除事务调用（hr PRD §6：删除前展示固定资产归属数、
 * 确认后置空固定资产的所属部门）；跳过会话守卫，走内部令牌认证。
 */
@Public()
@UseGuards(InternalAuthGuard)
@Controller('internal/v1/departments')
export class InternalDepartmentController {
  constructor(private readonly prisma: PrismaService) {}

  /** hr 删除预览：统计部门固定资产归属数（未逻辑删除的资产） */
  @Get(':id/asset-count')
  @AllowedCallers('hr')
  async assetCount(@Param('id', ParseIntPipe) departmentId: number): Promise<{ count: number }> {
    const count = await this.prisma.client.asset.count({
      where: { departmentId, deletedAt: null },
    });
    return { count };
  }

  /** hr 删除事务：置空固定资产的部门归属（department_id/department_name 置空） */
  @Post(':id/clear-assignments')
  @AllowedCallers('hr')
  async clearAssignments(@Param('id', ParseIntPipe) departmentId: number): Promise<{ ok: true }> {
    await this.prisma.client.asset.updateMany({
      where: { departmentId },
      data: { departmentId: null, departmentName: null },
    });
    return { ok: true };
  }
}
