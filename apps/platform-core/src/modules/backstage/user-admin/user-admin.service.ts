import { Inject, Injectable } from '@nestjs/common';
import {
  accountErrors,
  BusinessException,
  frameworkErrors,
  maskPhone,
  normalizePhoneInput,
  permissionErrors,
  USER_MANAGE_FUNCTION_CODE,
  type UserStatus,
} from '@wbme/contracts';
import { buildTablePrismaQuery, collectTableFilterFields, normalizeTableFilters, redisKey, REDIS_CLIENT, REDIS_NAMESPACE } from '@wbme/server';
import type { Redis } from 'ioredis';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../permission/operation-log.util';
import type { CreateUserDto, ListUsersDto, UpdateUserDto } from './user-admin.dto';

/**
 * 用户管理服务（backstage PRD §3）。
 *
 * - 操作人资格（持有"用户管理"功能或超管）由 FunctionPermissionGuard 在控制器层保证；
 *   超管目标保护（仅超管可管理超管账号）由本服务强制；
 * - 创建只产生待激活基础账号（无密码、未绑定钉钉；激活时以钉钉返回为准，base PRD §2）；
 *   手机号在待激活与正常账号间唯一（base B-1 部分唯一索引兜底，并发占用 P2002 → PHONE_TAKEN）；
 * - 编辑仅姓名与性别；手机号只读（不提供任何修改入口，backstage PRD §3）；
 * - 激活邀请/管理员发起密码重置/解锁复用 base 既有能力（admin-auth.controller 路由）；
 * - 写操作按主 PRD §3.3 写入 backstage 操作日志（feature=user_manage），支持幂等键。
 */

/** 操作日志幂等作用域 */
const IDEMPOTENCY_SCOPE = {
  USER_CREATE: 'users.create',
  USER_UPDATE: 'users.update',
} as const;

/** 用户列表结构化筛选白名单：keyword 匹配姓名/手机号，name/createdAt 支持页面列排序，status 为枚举。 */
const USER_FILTER_FIELDS = {
  keyword: { prismaField: ['name', 'phone'], type: 'text' },
  name: { prismaField: 'name', type: 'text' },
  createdAt: { prismaField: 'createdAt', type: 'date' },
  status: { prismaField: 'status', type: 'enum' },
} as const;

/** 用户列表/详情展示项 */
interface UserView {
  id: number;
  name: string;
  phoneMasked: string;
  gender: 'MALE' | 'FEMALE';
  status: UserStatus;
  isSuperAdmin: boolean;
  hasDingtalkBinding: boolean;
  createdAt: Date;
  deactivatedAt: Date | null;
  /** 是否处于登录锁定（Redis 账号锁；仅详情返回，列表不查询） */
  accountLocked?: boolean;
}

@Injectable()
export class UserAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * 创建用户（backstage PRD §3）：待激活基础账号（无密码、未绑定钉钉），
   * 由员工按 base PRD §2 使用一次性二维码/链接激活（激活邀请走 M1 接口）。
   *
   * @param operatorId 操作人 id
   * @param dto 姓名/手机号/性别 + 可选幂等键
   * @returns 新账号 id 与状态（重放返回首次创建结果）
   * @throws VALIDATION_FAILED 手机号无法规范化；PHONE_TAKEN 手机号被待激活/正常账号占用
   */
  async createUser(operatorId: number, dto: CreateUserDto): Promise<{ id: number; status: UserStatus }> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const phone = normalizePhoneInput(dto.phone);
    if (!phone) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: { phone: '手机号格式不正确' } });
    }
    const name = dto.name.trim();
    if (name.length === 0) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: { name: '姓名不能为空' } });
    }

    const fingerprint = fingerprintPayload({ name, phone, gender: dto.gender });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: USER_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.USER_CREATE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 手机号占用检查依赖数据库状态，在幂等预检查之后执行（同键重放直接返回首次结果）；
        // 唯一性由部分唯一索引兜底：status IN (PENDING_ACTIVATION, ACTIVE) AND deleted_at IS NULL
        const occupied = await tx.user.findFirst({
          where: { phone, status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] }, deletedAt: null },
          select: { id: true },
        });
        if (occupied) {
          throw new BusinessException(accountErrors.PHONE_TAKEN);
        }
        try {
          const user = await tx.user.create({
            data: { name, phone, gender: dto.gender, status: 'PENDING_ACTIVATION' },
          });
          return {
            result: { id: user.id, status: user.status },
            actionType: 'CREATE',
            summary: `创建用户：${name}（${maskPhone(phone)}），待激活`,
          };
        } catch (error) {
          // 并发创建撞手机号部分唯一索引 → 占用冲突
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(accountErrors.PHONE_TAKEN);
          }
          throw error;
        }
      },
    });
  }

  /**
   * 用户列表（backstage PRD §3）：状态筛选（正常/待激活/已注销）+ 姓名/手机号模糊 + 分页。
   * 缺省返回未注销账号；"已注销"筛选是主 PRD §2.6 默认过滤规则的管理专用例外。
   *
   * @param query 状态/检索词/分页
   * @returns data（含激活状态与钉钉绑定状态）与 pagination
   */
  async listUsers(query: ListUsersDto): Promise<{
    data: UserView[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const structuredFields = query.filters ? collectTableFilterFields(normalizeTableFilters(query.filters)) : new Set<string>();
    const where: Prisma.UserWhereInput = {};
    // 结构化筛选已覆盖 status 时，具名状态分支让位（含默认未注销规则）
    if (!structuredFields.has('status')) {
      if (query.status === 'DEACTIVATED') {
        where.status = 'DEACTIVATED';
      } else if (query.status) {
        where.status = query.status;
        where.deletedAt = null;
      } else {
        where.deletedAt = null;
      }
    }
    // 结构化筛选已覆盖 keyword 时，具名检索词让位
    if (!structuredFields.has('keyword')) {
      const keyword = query.keyword?.trim();
      if (keyword) {
        const conditions: Prisma.UserWhereInput[] = [{ name: { contains: keyword, mode: 'insensitive' } }];
        const digits = keyword.replace(/\D/g, '');
        if (digits.length > 0) {
          conditions.push({ phone: { contains: digits } });
        }
        where.OR = conditions;
      }
    }
    const tableQuery = buildTablePrismaQuery(query, USER_FILTER_FIELDS);
    if (tableQuery.where) {
      where.AND = [tableQuery.where];
    }
    const [totalItems, users] = await Promise.all([
      this.prisma.client.user.count({ where }),
      this.prisma.client.user.findMany({
        where,
        orderBy: tableQuery.orderBy ?? [{ id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          name: true,
          phone: true,
          gender: true,
          status: true,
          isSuperAdmin: true,
          createdAt: true,
          deletedAt: true,
        },
      }),
    ]);
    const boundIds = await this.loadBoundUserIds(users.map((user) => user.id));
    return {
      data: users.map((user) => this.toView(user, boundIds.has(user.id))),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  /**
   * 用户详情（含已注销账号：恢复预览与管理展示需要；携带登录锁定状态）。
   *
   * @param targetUserId 目标用户 id
   * @returns 用户展示项
   * @throws RESOURCE_NOT_FOUND 账号不存在
   */
  async getUserDetail(targetUserId: number): Promise<UserView> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        gender: true,
        status: true,
        isSuperAdmin: true,
        createdAt: true,
        deletedAt: true,
      },
    });
    if (!user) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const boundIds = await this.loadBoundUserIds([targetUserId]);
    // 登录锁定状态（Redis 账号锁；与解锁接口同一 key 构造，base PRD §4）
    const locked = (await this.redis.exists(redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'acct_lock', targetUserId))) === 1;
    return { ...this.toView(user, boundIds.has(targetUserId)), accountLocked: locked };
  }

  /**
   * 编辑用户基本资料（仅姓名和性别；手机号只读，backstage PRD §3）。
   *
   * @param operatorId 操作人 id
   * @param targetUserId 目标用户 id
   * @param dto 新姓名/性别 + 可选幂等键
   * @returns ok（重放返回首次结果）
   * @throws RESOURCE_NOT_FOUND 账号不存在；ACCOUNT_DEACTIVATED 已注销账号不可编辑（先恢复）；
   *         SUPER_ADMIN_TARGET_ONLY 非超管操作超管目标；VALIDATION_FAILED 无实际变更
   */
  async updateUser(operatorId: number, targetUserId: number, dto: UpdateUserDto): Promise<{ ok: true }> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const name = dto.name.trim();
    if (name.length === 0) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: { name: '姓名不能为空' } });
    }

    const fingerprint = fingerprintPayload({ targetUserId, name, gender: dto.gender });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: USER_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.USER_UPDATE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 依赖数据库状态的校验在幂等预检查之后执行：同键重放直接返回首次结果
        const target = await tx.user.findUnique({ where: { id: targetUserId } });
        if (!target) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (target.status === 'DEACTIVATED' || target.deletedAt !== null) {
          throw new BusinessException(accountErrors.ACCOUNT_DEACTIVATED);
        }
        if (target.isSuperAdmin && !operator.isSuperAdmin) {
          throw new BusinessException(permissionErrors.SUPER_ADMIN_TARGET_ONLY);
        }
        if (target.name === name && target.gender === dto.gender) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: { name: '姓名与性别均未变更' } });
        }
        await tx.user.update({
          where: { id: target.id },
          data: { name, gender: dto.gender, updatedBy: operator.id },
        });
        return {
          result: { ok: true as const },
          actionType: 'UPDATE',
          summary:
            `编辑用户：${maskPhone(target.phone)} 基本资料变更前 [${target.name} / ${target.gender === 'MALE' ? '男' : '女'}]，` +
            `变更后 [${name} / ${dto.gender === 'MALE' ? '男' : '女'}]`,
        };
      },
    });
  }

  /** 批量查询钉钉绑定状态（BOUND 绑定中的用户 id 集合） */
  private async loadBoundUserIds(userIds: readonly number[]): Promise<Set<number>> {
    if (userIds.length === 0) {
      return new Set();
    }
    const bindings = await this.prisma.client.dingtalkBinding.findMany({
      where: { userId: { in: [...userIds] }, status: 'BOUND' },
      select: { userId: true },
    });
    return new Set(bindings.map((binding) => binding.userId));
  }

  /** 组装展示项（手机号脱敏；deactivatedAt 取注销时间） */
  private toView(
    user: {
      id: number;
      name: string;
      phone: string;
      gender: 'MALE' | 'FEMALE';
      status: UserStatus;
      isSuperAdmin: boolean;
      createdAt: Date;
      deletedAt: Date | null;
    },
    hasDingtalkBinding: boolean,
  ): UserView {
    return {
      id: user.id,
      name: user.name,
      phoneMasked: maskPhone(user.phone),
      gender: user.gender,
      status: user.status,
      isSuperAdmin: user.isSuperAdmin,
      hasDingtalkBinding,
      createdAt: user.createdAt,
      deactivatedAt: user.deletedAt,
    };
  }
}
