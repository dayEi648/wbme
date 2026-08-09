import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '@wbme/contracts';
import { SystemLogService } from './system-log.service';

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
});
