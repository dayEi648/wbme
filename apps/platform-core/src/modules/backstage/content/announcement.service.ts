import { Injectable } from '@nestjs/common';
import {
  ANNOUNCEMENT_MANAGE_FUNCTION_CODE,
  BusinessException,
  createPaginationResponse,
  frameworkErrors,
} from '@wbme/contracts';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../permission/operation-log.util';
import type { BatchDeleteAnnouncementsDto, UpsertAnnouncementDto } from './content.dto';

const IDEMPOTENCY_SCOPE = {
  CREATE: 'announcements.create',
  UPDATE: 'announcements.update',
  PUBLISH: 'announcements.publish',
  REVOKE: 'announcements.revoke',
  BATCH_DELETE: 'announcements.batch-delete',
} as const;

/**
 * 系统公告管理服务（软删除；发布时事务内撤回当前展示）。
 */
@Injectable()
export class AnnouncementService {
  constructor(private readonly prisma: PrismaService) {}

  /** 公告列表（不含已软删） */
  async list(dto: { page: number; pageSize: number; status?: string }): Promise<unknown> {
    const where: Prisma.AnnouncementWhereInput = { deletedAt: null };
    if (dto.status) {
      where.status = dto.status as Prisma.EnumAnnouncementStatusFilter['equals'];
    }
    const skip = (dto.page - 1) * dto.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.announcement.findMany({
        where,
        // 次级 id 兜底：同秒更新时分页边界稳定（主 PRD §9.5）
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: dto.pageSize,
      }),
      this.prisma.client.announcement.count({ where }),
    ]);
    return createPaginationResponse(items, total, dto.page, dto.pageSize);
  }

  /** 创建草稿公告 */
  async create(operatorId: number, dto: UpsertAnnouncementDto): Promise<unknown> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload(dto);
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ANNOUNCEMENT_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.CREATE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        const row = await tx.announcement.create({
          data: {
            title: dto.title,
            content: dto.content ?? null,
            status: 'DRAFT',
            createdBy: operatorId,
            updatedBy: operatorId,
          },
        });
        return {
          result: { id: row.id },
          actionType: 'CREATE',
          summary: `创建公告「${dto.title}」`,
        };
      },
    });
  }

  /** 编辑公告（草稿/已撤回可编辑） */
  async update(operatorId: number, id: number, dto: UpsertAnnouncementDto): Promise<unknown> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload({ id, ...dto });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ANNOUNCEMENT_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.UPDATE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        const existing = await tx.announcement.findFirst({ where: { id, deletedAt: null } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (existing.status === 'PUBLISHING') {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '展示中的公告不可编辑，请先撤回' });
        }
        const row = await tx.announcement.update({
          where: { id },
          data: { title: dto.title, content: dto.content ?? null, updatedBy: operatorId },
        });
        return {
          result: { id: row.id },
          actionType: 'UPDATE',
          summary: `编辑公告「${dto.title}」`,
        };
      },
    });
  }

  /**
   * 发布公告：事务内撤回当前 PUBLISHING，再将目标设为 PUBLISHING（依赖部分唯一索引）。
   */
  async publish(operatorId: number, id: number, idempotencyKey?: string): Promise<unknown> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload({ id, action: 'publish' });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ANNOUNCEMENT_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.PUBLISH,
      idempotencyKey,
      fingerprint,
      run: async (tx) => {
        const target = await tx.announcement.findFirst({ where: { id, deletedAt: null } });
        if (!target) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await tx.announcement.updateMany({
          where: { status: 'PUBLISHING', deletedAt: null, id: { not: id } },
          data: { status: 'REVOKED', updatedBy: operatorId },
        });
        try {
          const row = await tx.announcement.update({
            where: { id },
            data: {
              status: 'PUBLISHING',
              publishedAt: new Date(),
              publisherId: operatorId,
              updatedBy: operatorId,
            },
          });
          return {
            result: { id: row.id, status: row.status },
            actionType: 'UPDATE',
            summary: `发布公告「${row.title}」`,
          };
        } catch (error) {
          // 并发发布两条不同公告时后者撞「单条展示」部分唯一索引（PUBLISHING 唯一）；
          // 非本请求幂等冲突（回查幂等表无记录），映射为明确的 409 而非透传 500
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.CONFLICT);
          }
          throw error;
        }
      },
    });
  }

  /** 撤回展示中的公告 */
  async revoke(operatorId: number, id: number, idempotencyKey?: string): Promise<unknown> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload({ id, action: 'revoke' });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ANNOUNCEMENT_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.REVOKE,
      idempotencyKey,
      fingerprint,
      run: async (tx) => {
        const existing = await tx.announcement.findFirst({ where: { id, deletedAt: null } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const row = await tx.announcement.update({
          where: { id },
          data: { status: 'REVOKED', updatedBy: operatorId },
        });
        return {
          result: { id: row.id, status: row.status },
          actionType: 'UPDATE',
          summary: `撤回公告「${row.title}」`,
        };
      },
    });
  }

  /** 批量软删除 */
  async batchDelete(operatorId: number, dto: BatchDeleteAnnouncementsDto): Promise<unknown> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const ids = dto.ids;
    const fingerprint = fingerprintPayload({ ids });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ANNOUNCEMENT_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.BATCH_DELETE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 整批校验（主 PRD §2.6：整批不变更 + 逐项目标原因）：不存在/已软删目标 → 整批回滚
        const existing = await tx.announcement.findMany({
          where: { id: { in: ids }, deletedAt: null },
          select: { id: true },
        });
        if (existing.length !== ids.length) {
          const found = new Set(existing.map((row) => row.id));
          const missing = ids.filter((id) => !found.has(id));
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
            fields: missing.map((id) => ({ id, reason: '公告不存在或已删除' })),
          });
        }
        const now = new Date();
        await tx.announcement.updateMany({
          where: { id: { in: ids } },
          data: { deletedAt: now, deletedBy: operatorId, status: 'REVOKED' },
        });
        return {
          result: { deleted: ids.length },
          actionType: 'DELETE',
          summary: `批量删除 ${ids.length} 条公告`,
        };
      },
    });
  }
}
