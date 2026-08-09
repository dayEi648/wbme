import { describe, expect, it } from 'vitest';
import { BusinessException, approvalErrors } from '@wbme/contracts';
import { isPrismaUniqueViolation, mapPendingLimitError, withPendingLimitMapping } from './pending-limit';

describe('pending-limit', () => {
  it('识别 Prisma P2002', () => {
    expect(isPrismaUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isPrismaUniqueViolation({ code: 'P2003' })).toBe(false);
    expect(isPrismaUniqueViolation(new Error('x'))).toBe(false);
  });

  it('P2002 映射 PENDING_LIMIT_REACHED', () => {
    try {
      mapPendingLimitError({ code: 'P2002' });
      expect.fail('应抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessException);
      expect((error as BusinessException).entry.code).toBe(approvalErrors.PENDING_LIMIT_REACHED.code);
    }
  });

  it('withPendingLimitMapping 透传成功结果', async () => {
    await expect(withPendingLimitMapping(async () => 42)).resolves.toBe(42);
  });

  it('withPendingLimitMapping 映射唯一冲突', async () => {
    await expect(
      withPendingLimitMapping(async () => {
        throw { code: 'P2002' };
      }),
    ).rejects.toMatchObject({ entry: { code: approvalErrors.PENDING_LIMIT_REACHED.code } });
  });
});
