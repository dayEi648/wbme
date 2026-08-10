import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationService } from './authorization.service';

function prismaMock(orgVersion: 'available' | 'unavailable') {
  return {
    client: {
      user: {
        findUnique: vi.fn().mockResolvedValue({ permissionVersion: 7, isSuperAdmin: false, deletedAt: null }),
      },
      permissionCatalogMeta: {
        findUnique: vi.fn().mockResolvedValue({ catalogVersion: 3 }),
      },
      $queryRaw:
        orgVersion === 'available'
          ? vi.fn().mockResolvedValue([{ user_org_version: 2, org_tree_version: 5 }])
          : vi.fn().mockRejectedValue(new Error('hr view unavailable')),
      employeeGrant: {
        findMany: vi.fn().mockResolvedValue([{ functionCode: 'asset.read', dataScope: 'SELF' }]),
      },
      function: {
        findMany: vi.fn().mockResolvedValue([{ code: 'asset.read' }]),
      },
    },
  };
}

describe('AuthorizationService 四版本缓存', () => {
  it('四版本可读且一致时复用 Redis 授权上下文', async () => {
    const prisma = prismaMock('available');
    const redis = {
      status: 'ready',
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          pv: 7,
          ov: 2,
          otv: 5,
          dv: 3,
          isSuperAdmin: false,
          grants: [{ functionCode: 'asset.read', dataScope: 'SELF' }],
        }),
      ),
      set: vi.fn(),
    };
    const service = new AuthorizationService(prisma as never, redis as never);

    await expect(service.getEffectiveGrants(42)).resolves.toEqual({
      isSuperAdmin: false,
      grants: [{ functionCode: 'asset.read', dataScope: 'SELF' }],
    });
    expect(prisma.client.employeeGrant.findMany).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('组织版本源不可读时回退实时读库，且绝不复用或写入零版本缓存', async () => {
    const prisma = prismaMock('unavailable');
    const redis = {
      status: 'ready',
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          pv: 7,
          ov: 0,
          otv: 0,
          dv: 3,
          isSuperAdmin: false,
          grants: [],
        }),
      ),
      set: vi.fn(),
    };
    const service = new AuthorizationService(prisma as never, redis as never);

    await expect(service.getEffectiveGrants(42)).resolves.toEqual({
      isSuperAdmin: false,
      grants: [{ functionCode: 'asset.read', dataScope: 'SELF' }],
    });
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(prisma.client.employeeGrant.findMany).toHaveBeenCalledWith({
      where: { userId: 42 },
      select: { functionCode: true, dataScope: true },
    });
  });
});
