import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '@wbme/contracts';
import { SystemLogService } from './system-log.service';

function prismaMock(): {
  client: { $queryRawUnsafe: ReturnType<typeof vi.fn> };
} {
  return {
    client: {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    },
  };
}

function redisMock(): never {
  return { redis: {} } as never;
}

function settingsMock(): never {
  return { getNumber: async () => 100 } as never;
}

describe('SystemLogService', () => {
  it('disposeError 无匹配行时抛 CONFLICT', async () => {
    const prisma = {
      client: {
        $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      },
    };
    const service = new SystemLogService(prisma as never, redisMock(), settingsMock());
    await expect(service.disposeError(1, 99, 'HANDLED')).rejects.toBeInstanceOf(BusinessException);
  });

  it('getErrorDetail 不存在时抛 RESOURCE_NOT_FOUND', async () => {
    const prisma = {
      client: {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      },
    };
    const service = new SystemLogService(prisma as never, redisMock(), settingsMock());
    await expect(service.getErrorDetail(999)).rejects.toBeInstanceOf(BusinessException);
  });

  describe('结构化筛选让位', () => {
    it('错误日志：filters 含 service/status 时具名参数被忽略', async () => {
      const prisma = prismaMock();
      const service = new SystemLogService(prisma as never, redisMock(), settingsMock());
      await service.listErrors({
        page: 1,
        pageSize: 20,
        service: 'platform-core',
        status: 'PENDING',
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [
            { field: 'service', operator: 'EQUALS', value: 'asset' },
            { field: 'status', operator: 'EQUALS', value: 'HANDLED' },
          ],
        }),
      });
      const sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      // 结构化筛选参数位置为 $1/$2，说明具名 service/status 未注入参数
      expect(sql).toContain('service ILIKE $1');
      // status 枚举列转换 text 后比较
      expect(sql).toContain('status::text = $2');
      expect(sql).not.toContain('service = $');
      expect(sql).not.toContain('status = $1::backstage');
    });

    it('安全日志：filters 含 eventType/actorId/targetUserId/result 时具名参数被忽略', async () => {
      const prisma = prismaMock();
      const service = new SystemLogService(prisma as never, redisMock(), settingsMock());
      await service.listSecurity({
        page: 1,
        pageSize: 20,
        eventType: 'LOGIN',
        actorId: 1,
        targetUserId: 2,
        result: 'SUCCESS',
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [
            { field: 'eventType', operator: 'EQUALS', value: 'LOGOUT' },
            { field: 'actorId', operator: 'EQUALS', value: '3' },
            { field: 'targetUserId', operator: 'EQUALS', value: '4' },
            { field: 'result', operator: 'EQUALS', value: 'FAILURE' },
          ],
        }),
      });
      const sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      // 结构化筛选参数位置为 $1-$4（枚举列转换 text 后比较）
      expect(sql).toContain('event_type::text = $1');
      expect(sql).toContain('actor_id = $2');
      expect(sql).toContain('target_user_id = $3');
      expect(sql).toContain('result::text = $4');
      expect(sql).not.toContain('event_type::text = $5');
    });

    it('无 filters 时具名参数正常追加', async () => {
      const prisma = prismaMock();
      const service = new SystemLogService(prisma as never, redisMock(), settingsMock());
      await service.listErrors({
        page: 1,
        pageSize: 20,
        service: 'platform-core',
        status: 'PENDING',
      });
      const sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      expect(sql).toContain('service = $1');
      expect(sql).toContain('status = $2');
    });

    it('错误日志支持 createdAt 筛选与排序（映射到 first_seen_at）', async () => {
      const prisma = prismaMock();
      const service = new SystemLogService(prisma as never, redisMock(), settingsMock());
      await service.listErrors({
        page: 1,
        pageSize: 20,
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [{ field: 'createdAt', operator: 'AFTER', value: '2025-01-01' }],
        }),
        sorts: JSON.stringify([{ field: 'createdAt', direction: 'DESC' }]),
      });
      const sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      // buildErrorWhere 无具名参数但保留 parameterOffset，结构化参数占位符为 $2
      expect(sql).toContain('first_seen_at >= $2');
      expect(sql).toContain('first_seen_at DESC');
      expect(sql).toContain('LIMIT $3 OFFSET $4');
    });

    it('安全日志支持 createdAt 排序', async () => {
      const prisma = prismaMock();
      const service = new SystemLogService(prisma as never, redisMock(), settingsMock());
      await service.listSecurity({
        page: 1,
        pageSize: 20,
        sorts: JSON.stringify([{ field: 'createdAt', direction: 'ASC' }]),
      });
      const sql = vi.mocked(prisma.client.$queryRawUnsafe).mock.calls[0]![0] as string;
      expect(sql).toContain('created_at ASC');
    });
  });
});
