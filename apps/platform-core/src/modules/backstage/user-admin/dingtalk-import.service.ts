import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  accountErrors,
  BATCH_LIMIT,
  BusinessException,
  frameworkErrors,
  integrationErrors,
  normalizePhoneFromParts,
  USER_MANAGE_FUNCTION_CODE,
} from '@wbme/contracts';
import { insertSecurityLog, type RawSqlClient } from '@wbme/logging';
import { getRequestContext, REDIS_CLIENT, REDIS_NAMESPACE, redisKey, type Redis } from '@wbme/server';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import { PasswordService } from '../../base/auth/password.service';
import { DingtalkConfigService } from '../../base/dingtalk/dingtalk-config.service';
import {
  DINGTALK_GATEWAY,
  DingtalkUnavailableError,
  type DingtalkDirectoryMember,
  type DingtalkGateway,
} from '../../base/dingtalk/dingtalk.gateway';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
  tryReplayIdempotentResult,
} from '../permission/operation-log.util';
import type { ImportDingtalkUsersDto, ListDingtalkImportCandidatesDto } from './user-admin.dto';

const DIRECTORY_SNAPSHOT_TTL_SECONDS = 5 * 60;
const IMPORT_NAME_MAX_LENGTH = 50;
const IDEMPOTENCY_SCOPE = 'users.dingtalk-import';

interface DingtalkDirectorySnapshot {
  operatorId: number;
  members: DingtalkDirectoryMember[];
}

interface ImportableMember {
  unionId: string;
  name: string;
  phone: string;
}

interface CandidateView {
  unionId: string;
  name: string;
  phone: string;
  importable: boolean;
  disabledReason?: string;
}

/**
 * 钉钉组织架构导入。
 *
 * 通讯录原始数据只在 Redis 保存五分钟并按操作人隔离；浏览器提交只允许 unionId，
 * 最终导入前仍会重新读取钉钉组织架构和数据库占用状态，不能把快照当作授权或写入依据。
 */
@Injectable()
export class DingtalkImportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(DINGTALK_GATEWAY) private readonly gateway: DingtalkGateway,
    private readonly config: DingtalkConfigService,
    private readonly password: PasswordService,
  ) {}

  /** 获取短时快照中的候选员工；首次打开或 refresh=true 时重新拉取钉钉组织架构。 */
  async listCandidates(
    operatorId: number,
    query: ListDingtalkImportCandidatesDto,
  ): Promise<{
    snapshotId: string;
    data: CandidateView[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    await this.assertImportConfigured();
    const snapshot = await this.loadSnapshot(operatorId, query.snapshotId, query.refresh === true);
    const candidates = await this.toCandidateViews(snapshot.members);
    const keyword = query.keyword?.trim().toLocaleLowerCase();
    const keywordDigits = keyword?.replace(/\D/g, '') ?? '';
    const filtered = keyword
      ? candidates.filter((member) => member.name.toLocaleLowerCase().includes(keyword) || (keywordDigits.length > 0 && member.phone.replace(/\D/g, '').includes(keywordDigits)))
      : candidates;
    const start = (query.page - 1) * query.pageSize;
    return {
      snapshotId: snapshot.id,
      data: filtered.slice(start, start + query.pageSize),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: filtered.length,
        totalPages: Math.ceil(filtered.length / query.pageSize),
      },
    };
  }

  /**
   * 原子批量导入。先确认快照属于当前操作人，再重新拉取钉钉目录；事务内复查
   * 手机号与 unionId 的全局占用，任一失败整批零写入。
   */
  async importUsers(operatorId: number, dto: ImportDingtalkUsersDto): Promise<{ userIds: number[]; importedCount: number }> {
    const unionIds = dto.unionIds.map((unionId) => unionId.trim());
    if (unionIds.some((unionId) => unionId.length === 0) || new Set(unionIds).size !== unionIds.length) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: [{ field: 'unionIds', errors: ['钉钉 ID 不能为空且不能重复'] }],
      });
    }
    const fingerprint = fingerprintPayload({ snapshotId: dto.snapshotId, unionIds });
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    if (dto.idempotencyKey) {
      const replayed = await tryReplayIdempotentResult<{ userIds: number[]; importedCount: number }>(this.prisma.client, {
        operatorId,
        scope: IDEMPOTENCY_SCOPE,
        idempotencyKey: dto.idempotencyKey,
        fingerprint,
      });
      if (replayed.found) {
        return replayed.result;
      }
    }
    const importConfig = await this.config.getImportCredentials();
    if (!importConfig) {
      throw new BusinessException(accountErrors.DINGTALK_IMPORT_CONFIG_MISSING);
    }
    if (!(await this.readSnapshot(operatorId, dto.snapshotId))) {
      throw new BusinessException(frameworkErrors.CONFLICT);
    }
    const freshMembers = await this.fetchDirectoryMembers();
    const memberByUnionId = new Map(freshMembers.map((member) => [member.unionId, member]));
    const resolved = unionIds.map((unionId) => memberByUnionId.get(unionId));
    const selectedMembers = this.validateSelectedMembers(unionIds, resolved);
    const passwordHash = await this.password.hash(importConfig.defaultPassword);
    let result: { userIds: number[]; importedCount: number };
    try {
      result = await executeIdempotentOperation(this.prisma.client, {
        operator,
        feature: USER_MANAGE_FUNCTION_CODE,
        scope: IDEMPOTENCY_SCOPE,
        idempotencyKey: dto.idempotencyKey,
        fingerprint,
        run: async (tx) => {
          const failures = await this.databaseConflicts(tx, selectedMembers);
          if (failures.length > 0) {
            throw new BusinessException(accountErrors.USER_BATCH_BLOCKED, { failures });
          }
          const userIds: number[] = [];
          for (const member of selectedMembers) {
            const user = await tx.user.create({
              data: {
                name: member.name,
                gender: 'MALE',
                phone: member.phone,
                passwordHash,
                status: 'ACTIVE',
                createdBy: operatorId,
              },
            });
            await tx.dingtalkBinding.create({
              data: {
                userId: user.id,
                dingtalkUnionId: member.unionId,
                status: 'BOUND',
                createdBy: operatorId,
              },
            });
            await insertSecurityLog(tx as unknown as RawSqlClient, {
              eventType: 'DINGTALK_BOUND',
              result: 'SUCCESS',
              actorId: operatorId,
              targetUserId: user.id,
              reason: '管理员从钉钉组织架构导入并自动绑定',
              requestId: getRequestContext()?.requestId ?? null,
            });
            userIds.push(user.id);
          }
          return {
            result: { userIds, importedCount: userIds.length },
            actionType: 'CREATE' as const,
            summary: `从钉钉导入了 ${userIds.length} 名员工并自动绑定钉钉账号`,
          };
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BusinessException(accountErrors.USER_BATCH_BLOCKED, {
          failures: unionIds.map((unionId) => ({ unionId, code: 'CONCURRENT_OCCUPIED', message: '账号信息已被并发占用，请刷新后重试' })),
        });
      }
      throw error;
    }
    return result;
  }

  private async assertImportConfigured(): Promise<void> {
    if (!(await this.config.getImportCredentials())) {
      throw new BusinessException(accountErrors.DINGTALK_IMPORT_CONFIG_MISSING);
    }
  }

  private async loadSnapshot(
    operatorId: number,
    requestedSnapshotId: string | undefined,
    forceRefresh: boolean,
  ): Promise<DingtalkDirectorySnapshot & { id: string }> {
    if (!forceRefresh && requestedSnapshotId) {
      const existing = await this.readSnapshot(operatorId, requestedSnapshotId);
      if (existing) {
        return { ...existing, id: requestedSnapshotId };
      }
    }
    const members = await this.fetchDirectoryMembers();
    const id = randomUUID();
    const snapshot: DingtalkDirectorySnapshot = { operatorId, members };
    await this.redis.set(this.snapshotKey(operatorId, id), JSON.stringify(snapshot), 'EX', DIRECTORY_SNAPSHOT_TTL_SECONDS);
    return { ...snapshot, id };
  }

  private async readSnapshot(operatorId: number, snapshotId: string): Promise<DingtalkDirectorySnapshot | null> {
    const raw = await this.redis.get(this.snapshotKey(operatorId, snapshotId));
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DingtalkDirectorySnapshot>;
      if (parsed.operatorId !== operatorId || !Array.isArray(parsed.members) || !parsed.members.every(this.isDirectoryMember)) {
        return null;
      }
      return { operatorId, members: parsed.members };
    } catch {
      return null;
    }
  }

  private snapshotKey(operatorId: number, snapshotId: string): string {
    return redisKey(REDIS_NAMESPACE.DINGTALK_DIRECTORY, operatorId, snapshotId);
  }

  private isDirectoryMember(value: unknown): value is DingtalkDirectoryMember {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const member = value as Partial<DingtalkDirectoryMember>;
    return (
      typeof member.unionId === 'string' &&
      typeof member.name === 'string' &&
      typeof member.mobile === 'string' &&
      typeof member.stateCode === 'string' &&
      typeof member.active === 'boolean'
    );
  }

  private async fetchDirectoryMembers(): Promise<DingtalkDirectoryMember[]> {
    try {
      return await this.gateway.listDirectoryMembers();
    } catch (error) {
      if (error instanceof DingtalkUnavailableError) {
        throw new BusinessException(integrationErrors.DINGTALK_UNAVAILABLE);
      }
      throw error;
    }
  }

  private async toCandidateViews(members: DingtalkDirectoryMember[]): Promise<CandidateView[]> {
    const phones = members
      .map((member) => normalizePhoneFromParts(member.stateCode, member.mobile))
      .filter((phone): phone is string => phone !== null);
    const unionIds = members.map((member) => member.unionId).filter(Boolean);
    const [occupiedUsers, existingBindings] = await Promise.all([
      phones.length === 0
        ? []
        : this.prisma.client.user.findMany({
            where: { phone: { in: phones }, deletedAt: null, status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] } },
            select: { phone: true },
          }),
      unionIds.length === 0
        ? []
        : this.prisma.client.dingtalkBinding.findMany({
            where: { dingtalkUnionId: { in: unionIds } },
            select: { dingtalkUnionId: true },
          }),
    ]);
    const occupiedPhones = new Set(occupiedUsers.map((user) => user.phone));
    const boundUnionIds = new Set(existingBindings.map((binding) => binding.dingtalkUnionId));
    const phoneCounts = new Map<string, number>();
    for (const phone of phones) {
      phoneCounts.set(phone, (phoneCounts.get(phone) ?? 0) + 1);
    }
    return members
      .map((member) => {
        const phone = normalizePhoneFromParts(member.stateCode, member.mobile);
        const disabledReason = this.candidateDisabledReason(member, phone, phoneCounts, occupiedPhones, boundUnionIds);
        return {
          unionId: member.unionId,
          name: member.name,
          phone: phone ?? member.mobile,
          importable: disabledReason === undefined,
          ...(disabledReason === undefined ? {} : { disabledReason }),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.unionId.localeCompare(right.unionId));
  }

  private candidateDisabledReason(
    member: DingtalkDirectoryMember,
    phone: string | null,
    phoneCounts: Map<string, number>,
    occupiedPhones: Set<string>,
    boundUnionIds: Set<string>,
  ): string | undefined {
    if (!member.active) return '该员工已离职';
    if (!member.unionId || member.unionId.length > 128) return '钉钉 ID 无效';
    if (!member.name.trim() || member.name.trim().length > IMPORT_NAME_MAX_LENGTH) return '姓名不符合平台要求';
    if (!phone) return '未获取到有效手机号';
    if ((phoneCounts.get(phone) ?? 0) > 1) return '钉钉组织内手机号重复';
    if (boundUnionIds.has(member.unionId)) return '钉钉 ID 已绑定平台账号';
    if (occupiedPhones.has(phone)) return '手机号已被平台账号使用';
    return undefined;
  }

  private validateSelectedMembers(
    unionIds: string[],
    resolved: Array<DingtalkDirectoryMember | undefined>,
  ): ImportableMember[] {
    if (unionIds.length > BATCH_LIMIT) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED);
    }
    const failures: Array<{ unionId: string; code: string; message: string }> = [];
    const members: ImportableMember[] = [];
    const selectedPhones = new Set<string>();
    for (let index = 0; index < unionIds.length; index += 1) {
      const unionId = unionIds[index] ?? '';
      const member = resolved[index];
      if (!member) {
        failures.push({ unionId, code: 'DINGTALK_MEMBER_NOT_FOUND', message: '员工已不在当前钉钉组织架构中' });
        continue;
      }
      const phone = normalizePhoneFromParts(member.stateCode, member.mobile);
      if (!member.active) {
        failures.push({ unionId, code: 'DINGTALK_MEMBER_INACTIVE', message: '员工已离职' });
      } else if (!member.name.trim() || member.name.trim().length > IMPORT_NAME_MAX_LENGTH) {
        failures.push({ unionId, code: 'INVALID_NAME', message: '员工姓名不符合平台要求' });
      } else if (!phone) {
        failures.push({ unionId, code: 'INVALID_PHONE', message: '未获取到有效手机号' });
      } else if (selectedPhones.has(phone)) {
        failures.push({ unionId, code: 'DUPLICATE_PHONE', message: '选中员工存在重复手机号' });
      } else {
        selectedPhones.add(phone);
        members.push({ unionId, name: member.name.trim(), phone });
      }
    }
    if (failures.length > 0) {
      throw new BusinessException(accountErrors.USER_BATCH_BLOCKED, { failures });
    }
    return members;
  }

  private async databaseConflicts(
    tx: Prisma.TransactionClient,
    members: ImportableMember[],
  ): Promise<Array<{ unionId: string; code: string; message: string }>> {
    const [occupiedUsers, existingBindings] = await Promise.all([
      tx.user.findMany({
        where: { phone: { in: members.map((member) => member.phone) }, deletedAt: null, status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] } },
        select: { phone: true },
      }),
      tx.dingtalkBinding.findMany({
        where: { dingtalkUnionId: { in: members.map((member) => member.unionId) } },
        select: { dingtalkUnionId: true },
      }),
    ]);
    const occupiedPhones = new Set(occupiedUsers.map((user) => user.phone));
    const boundUnionIds = new Set(existingBindings.map((binding) => binding.dingtalkUnionId));
    return members.flatMap((member) => {
      if (boundUnionIds.has(member.unionId)) {
        return [{ unionId: member.unionId, code: 'DINGTALK_ALREADY_BOUND', message: '钉钉 ID 已绑定平台账号' }];
      }
      if (occupiedPhones.has(member.phone)) {
        return [{ unionId: member.unionId, code: 'PHONE_TAKEN', message: '手机号已被平台账号使用' }];
      }
      return [];
    });
  }
}
