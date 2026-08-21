import { describe, expect, it } from 'vitest';
import { buildHrApprovalRequestTableQuery } from './table-query';

describe('buildHrApprovalRequestTableQuery', () => {
  it('keyword 关键字映射为申请编号/申请人/审批人多字段任一匹配（与具名 keyword 同口径）', () => {
    const result = buildHrApprovalRequestTableQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'CONTAINS', value: '张' }] }),
    });

    expect(result.where).toEqual({
      AND: [{
        OR: [
          { applicationNo: { contains: '张', mode: 'insensitive' } },
          { applicantName: { contains: '张', mode: 'insensitive' } },
          { processorName: { contains: '张', mode: 'insensitive' } },
        ],
      }],
    });
  });

  it('keyword「不等于」按多字段全部不匹配编译（AND 组合）', () => {
    const result = buildHrApprovalRequestTableQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'NOT_EQUALS', value: '张' }] }),
    });

    expect(result.where).toEqual({
      AND: [{
        AND: [
          { applicationNo: { not: { equals: '张', mode: 'insensitive' } } },
          { applicantName: { not: { equals: '张', mode: 'insensitive' } } },
          { processorName: { not: { equals: '张', mode: 'insensitive' } } },
        ],
      }],
    });
  });
});
