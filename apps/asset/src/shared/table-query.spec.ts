import { describe, expect, it } from 'vitest';
import { buildAssetApprovalRequestTableQuery } from './table-query';

describe('buildAssetApprovalRequestTableQuery', () => {
  it('keyword 关键字映射为申请编号/申请人/审批人多字段任一匹配（与具名 keyword 同口径）', () => {
    const result = buildAssetApprovalRequestTableQuery({
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

  it('requestType「消耗品申领」展开包含代交申领（与具名参数同口径），其余类型标准编译', () => {
    const expanded = buildAssetApprovalRequestTableQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'requestType', operator: 'EQUALS', value: 'CONSUMABLE_REQUEST' }] }),
    });
    expect(expanded.where).toEqual({ AND: [{ requestType: { in: ['CONSUMABLE_REQUEST', 'AGENT_REQUEST'] } }] });

    const expandedNot = buildAssetApprovalRequestTableQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'requestType', operator: 'NOT_EQUALS', value: 'CONSUMABLE_REQUEST' }] }),
    });
    expect(expandedNot.where).toEqual({ AND: [{ requestType: { notIn: ['CONSUMABLE_REQUEST', 'AGENT_REQUEST'] } }] });

    const standard = buildAssetApprovalRequestTableQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'requestType', operator: 'EQUALS', value: 'BORROW' }] }),
    });
    expect(standard.where).toEqual({ AND: [{ requestType: 'BORROW' }] });
  });
});
