import { Injectable } from '@nestjs/common';
import { createPaginationResponse } from '@wbme/contracts';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';

/** 追加更新日志入参 */
export interface AppendReleaseLogInput {
  releaseId: string;
  version: string;
  commitSha: string;
  subjects?: string[];
}

/**
 * 更新日志服务（只追加；releaseId 唯一）。
 */
@Injectable()
export class ReleaseLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 分页列出更新日志（按创建时间倒序）。
   */
  async list(dto: { page: number; pageSize: number }): Promise<unknown> {
    const skip = (dto.page - 1) * dto.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.releaseLog.findMany({
        // 次级 id 兜底：同秒创建时分页边界稳定（主 PRD §9.5）
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: dto.pageSize,
      }),
      this.prisma.client.releaseLog.count(),
    ]);
    return createPaginationResponse(items, total, dto.page, dto.pageSize);
  }

  /**
   * 发布流程追加更新日志（releaseId 幂等）。
   *
   * @param input 版本与提交信息
   * @returns 新建或已存在的记录
   */
  async appendReleaseLog(input: AppendReleaseLogInput): Promise<{ id: number; releaseId: string; created: boolean }> {
    const existing = await this.prisma.client.releaseLog.findUnique({
      where: { releaseId: input.releaseId },
      select: { id: true, releaseId: true },
    });
    if (existing) {
      return { ...existing, created: false };
    }
    const created = await this.prisma.client.releaseLog.create({
      data: {
        releaseId: input.releaseId,
        version: input.version,
        commitSha: input.commitSha,
        commitSubjects: input.subjects ?? Prisma.JsonNull,
      },
      select: { id: true, releaseId: true },
    });
    return { ...created, created: true };
  }
}

/** 供部署脚本调用的独立 helper */
export async function appendReleaseLog(
  prisma: PrismaService['client'],
  input: AppendReleaseLogInput,
): Promise<{ id: number; releaseId: string; created: boolean }> {
  const service = new ReleaseLogService({ client: prisma } as PrismaService);
  return service.appendReleaseLog(input);
}
