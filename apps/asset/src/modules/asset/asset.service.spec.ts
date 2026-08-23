import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BusinessException, frameworkErrors, type MyAssetQueryDto } from '@wbme/contracts';
import { buildMyAssetTableQuery } from './asset.service';

/**
 * 我的资产结构化查询回归（GAP-1）：
 * - scope 为纯 compile 字段，支持 EQUALS/NOT_EQUALS 三值；
 * - 非法操作符/非法 value 抛 400；
 * - filters 树中出现 scope 时具名 query.scope 让位；
 * - name / updatedAt 开放排序。
 */
describe('buildMyAssetTableQuery', () => {
  const userId = 42;
  const scopeFilter = (operator: string, value: string) =>
    JSON.stringify({ logic: 'AND', conditions: [{ field: 'scope', operator, value }] });
  const query = (overrides: Partial<MyAssetQueryDto>): MyAssetQueryDto =>
    ({ page: 1, pageSize: 20, scope: 'ALL', ...overrides });

  it('scope EQUALS OWNED 映射为 responsibleUserId = userId', () => {
    const result = buildMyAssetTableQuery(userId, query({ filters: scopeFilter('EQUALS', 'OWNED') }));
    expect(result.where).toEqual({
      AND: [{ deletedAt: null }, { AND: [{ responsibleUserId: userId }] }],
    });
  });

  it('scope EQUALS USED 映射为 currentUserId = userId', () => {
    const result = buildMyAssetTableQuery(userId, query({ filters: scopeFilter('EQUALS', 'USED') }));
    expect(result.where).toEqual({
      AND: [{ deletedAt: null }, { AND: [{ currentUserId: userId }] }],
    });
  });

  it('scope EQUALS ALL 映射为 responsibleUserId 或 currentUserId 等于 userId', () => {
    const result = buildMyAssetTableQuery(userId, query({ scope: 'OWNED', filters: scopeFilter('EQUALS', 'ALL') }));
    expect(result.where).toEqual({
      AND: [{ deletedAt: null }, { AND: [{ OR: [{ responsibleUserId: userId }, { currentUserId: userId }] }] }],
    });
  });

  it('scope NOT_EQUALS OWNED 用 Prisma NOT 否定 responsibleUserId', () => {
    const result = buildMyAssetTableQuery(userId, query({ filters: scopeFilter('NOT_EQUALS', 'OWNED') }));
    expect(result.where).toEqual({
      AND: [{ deletedAt: null }, { AND: [{ NOT: { responsibleUserId: userId } }] }],
    });
  });

  it('scope NOT_EQUALS USED 用 Prisma NOT 否定 currentUserId', () => {
    const result = buildMyAssetTableQuery(userId, query({ filters: scopeFilter('NOT_EQUALS', 'USED') }));
    expect(result.where).toEqual({
      AND: [{ deletedAt: null }, { AND: [{ NOT: { currentUserId: userId } }] }],
    });
  });

  it('scope NOT_EQUALS ALL 编译为两者均不等于 userId', () => {
    const result = buildMyAssetTableQuery(userId, query({ filters: scopeFilter('NOT_EQUALS', 'ALL') }));
    expect(result.where).toEqual({
      AND: [
        { deletedAt: null },
        {
          AND: [
            {
              AND: [{ responsibleUserId: { not: userId } }, { currentUserId: { not: userId } }],
            },
          ],
        },
      ],
    });
  });

  it('scope 不支持 EQUALS/NOT_EQUALS 之外的操作符时抛 400', () => {
    expect(() => buildMyAssetTableQuery(userId, query({ filters: scopeFilter('CONTAINS', 'OWNED') })))
      .toThrow(BusinessException);
    const error = captureError(() => buildMyAssetTableQuery(userId, query({ filters: scopeFilter('CONTAINS', 'OWNED') })));
    expect(error).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
  });

  it('scope value 不是 OWNED/USED/ALL 时抛 400', () => {
    expect(() => buildMyAssetTableQuery(userId, query({ filters: scopeFilter('EQUALS', 'INVALID') })))
      .toThrow(BusinessException);
  });

  it('filters 树中出现 scope 时具名 query.scope 让位', () => {
    const result = buildMyAssetTableQuery(userId, query({
      scope: 'USED',
      filters: scopeFilter('EQUALS', 'OWNED'),
    }));
    // 命名 scope=USED 应被让位，结果以树中 OWNED 为准
    expect(result.where).toEqual({
      AND: [{ deletedAt: null }, { AND: [{ responsibleUserId: userId }] }],
    });
  });

  it('name / updatedAt 支持结构化排序', () => {
    const result = buildMyAssetTableQuery(userId, query({
      sorts: JSON.stringify([
        { field: 'name', direction: 'ASC' },
        { field: 'updatedAt', direction: 'DESC' },
      ]),
    }));
    expect(result.orderBy).toEqual([{ name: 'asc' }, { updatedAt: 'desc' }, { id: 'desc' }]);
  });
});

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('预期操作抛出异常');
}
