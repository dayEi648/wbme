import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import type { DepartmentClosureService } from '../../shared/department-closure.service';
import type { HolidayAdapter } from '../holiday/holiday.adapter';
import type { HrApprovalService } from '../approval/hr-approval.service';
import { buildOvertimeMineListQuery, OvertimeController } from './overtime.controller';
import type { OvertimeExportService } from './overtime-export.service';
import type { OvertimeSubmissionService } from './overtime-submission.service';
import type { OvertimeSummaryService } from './overtime-summary.service';

function createController(rows: Array<Record<string, unknown>>) {
  const queryRawUnsafe = vi.fn()
    .mockResolvedValueOnce([{ total: BigInt(rows.length) }])
    .mockResolvedValueOnce(rows);
  const mockPrisma = { client: { $queryRawUnsafe: queryRawUnsafe } } as unknown as PrismaService;
  const controller = new OvertimeController(
    mockPrisma,
    {} as OvertimeSubmissionService,
    {} as HrApprovalService,
    {} as OvertimeSummaryService,
    {} as OvertimeExportService,
    {} as DepartmentClosureService,
    {} as HolidayAdapter,
  );
  return { controller, queryRawUnsafe };
}

describe('buildOvertimeMineListQuery', () => {
  it('默认按日期和 id 倒序，并只以当前用户和已批准状态作为范围', () => {
    const result = buildOvertimeMineListQuery(7, {});

    expect(result.whereSql).toBe("WHERE oi.user_id = $1 AND r.status = 'APPROVED'");
    expect(result.params).toEqual([7]);
    expect(result.orderBySql).toBe('oi.overtime_date DESC, oi.id DESC');
  });

  it('将具名月份编译为可索引的日期范围', () => {
    const result = buildOvertimeMineListQuery(7, { month: '2026-08' });

    expect(result.whereSql).toContain('oi.overtime_date >= $2::date AND oi.overtime_date < $3::date');
    expect(result.whereSql).not.toContain('TO_CHAR');
    expect(result.params).toEqual([7, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-09-01T00:00:00.000Z')]);
  });

  it('结构化月份优先于具名月份，并同样使用日期范围', () => {
    const result = buildOvertimeMineListQuery(7, {
      month: '2026-09',
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'month', operator: 'EQUALS', value: '2026-08' }] }),
    });

    expect(result.params).toEqual([7, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-09-01T00:00:00.000Z')]);
    expect(result.whereSql).not.toContain('$4');
  });

  it('将排序限制在受控列表达式并追加 id 保证分页稳定', () => {
    const result = buildOvertimeMineListQuery(7, {
      sorts: JSON.stringify([{ field: 'minutes', direction: 'ASC' }]),
    });

    expect(result.orderBySql).toBe('(oi.end_minute - oi.start_minute) ASC, oi.id DESC');
  });

  it('拒绝非等于月份和未注册排序字段', () => {
    expect(() => buildOvertimeMineListQuery(7, {
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'month', operator: 'CONTAINS', value: '2026' }] }),
    })).toThrow(BusinessException);
    expect(() => buildOvertimeMineListQuery(7, {
      sorts: JSON.stringify([{ field: 'reason; DROP TABLE hr.overtime_items', direction: 'ASC' }]),
    })).toThrow(BusinessException);
  });
});

describe('OvertimeController.mine', () => {
  it('只读取当前页，并将数据库行转换为接口记录', async () => {
    const { controller, queryRawUnsafe } = createController([{
      id: 42,
      application_no: 'OT-42',
      overtime_date: new Date('2026-08-20T00:00:00.000Z'),
      start_minute: 600,
      end_minute: 720,
      reason: '月末值班',
      date_type: 'WORKDAY',
    }]);

    const result = await controller.mine(7, {
      page: 2,
      pageSize: 10,
    } as Parameters<OvertimeController['mine']>[1]);

    expect(result).toEqual({
      data: [{
        id: 42,
        applicationNo: 'OT-42',
        overtimeDate: '2026-08-20',
        startMinute: 600,
        endMinute: 720,
        minutes: 120,
        hours: 2,
        reason: '月末值班',
        dateType: 'WORKDAY',
      }],
      pagination: { page: 2, pageSize: 10, totalItems: 1, totalPages: 1 },
    });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    const [countSql] = queryRawUnsafe.mock.calls[0] as [string];
    const [listSql, userId, limit, offset] = queryRawUnsafe.mock.calls[1] as [string, number, number, number];
    expect(countSql).toContain("WHERE oi.user_id = $1 AND r.status = 'APPROVED'");
    expect(listSql).toContain('ORDER BY oi.overtime_date DESC, oi.id DESC');
    expect(listSql).toContain('LIMIT $2 OFFSET $3');
    expect([userId, limit, offset]).toEqual([7, 10, 10]);
  });
});
