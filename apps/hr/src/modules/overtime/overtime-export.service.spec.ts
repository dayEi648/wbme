import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import { OvertimeExportService, buildOvertimeReportSql } from './overtime-export.service';

describe('buildOvertimeReportSql', () => {
  it('无筛选时覆盖授权范围内全部已批准历史，不再隐式限制为当月', () => {
    const result = buildOvertimeReportSql(new Set([7, 9]), {});

    expect(result).toMatchObject({
      whereSql: "WHERE r.status = 'APPROVED' AND oi.user_id = ANY($1)",
      params: [[7, 9]],
      userIds: [7, 9],
      includeZeroStatistics: true,
    });
  });

  it('将姓名、部门、日期和时段条件全部参数化', () => {
    const result = buildOvertimeReportSql(new Set([7]), {
      filters: JSON.stringify({
        logic: 'AND',
        conditions: [
          { field: 'employeeName', operator: 'CONTAINS', value: "张三' OR 1=1 --" },
          { field: 'departmentId', operator: 'EQUALS', value: '12' },
          { field: 'overtimeDate', operator: 'BETWEEN', value: '2026-01-01', valueEnd: '2026-12-31' },
          { field: 'startTime', operator: 'BETWEEN', value: '09:00', valueEnd: '18:00' },
          { field: 'endTime', operator: 'EQUALS', value: '24:00' },
        ],
      }),
    });

    expect(result.whereSql).toContain('oi.user_name ILIKE');
    expect(result.whereSql).toContain('oi.department_snapshot @>');
    expect(result.whereSql).toContain('oi.overtime_date >=');
    expect(result.whereSql).toContain('oi.start_minute >=');
    expect(result.whereSql).toContain('oi.end_minute =');
    expect(result.whereSql).not.toContain("张三' OR 1=1 --");
    expect(result.params).toEqual(expect.arrayContaining(["张三' OR 1=1 --", JSON.stringify([{ id: 12 }]), 540, 1080, 1440]));
  });

  it('拒绝未注册字段，避免客户端拼接任意 SQL 列', () => {
    expect(() => buildOvertimeReportSql(new Set([7]), {
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'oi.user_id; DROP TABLE hr.overtime_items', operator: 'EQUALS', value: '7' }] }),
    })).toThrow(BusinessException);
  });

  it('具名部门参数也匹配申请时部门快照，不再按员工当前部门解释', () => {
    const result = buildOvertimeReportSql(new Set([7]), { departmentId: 12 });

    expect(result.whereSql).toContain('oi.department_snapshot @> $2::jsonb');
    expect(result.params).toEqual([[7], JSON.stringify([{ id: 12 }])]);
  });
});

describe('OvertimeExportService.listRecords', () => {
  it('按明细分页并返回人员、组织、申请和审批信息', async () => {
    const queryRawUnsafe = vi.fn()
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([{
        id: 31,
        application_no: 'OT2026090401',
        user_name: '张三',
        department_names: '研发部',
        position_name: '工程师',
        reason: '上线保障',
        overtime_date: new Date('2026-09-04T00:00:00.000Z'),
        start_minute: 1080,
        end_minute: 1200,
        minutes: BigInt(120),
        date_type: 'WORKDAY',
        is_backfill: false,
        applicant_name: '李四',
        proxy_name: '王五',
        submitted_at: new Date('2026-09-04T01:00:00.000Z'),
        processor_name: '赵六',
        processed_at: new Date('2026-09-04T03:00:00.000Z'),
        status: 'APPROVED',
      }]);
    const prisma = {
      client: {
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ $queryRawUnsafe: queryRawUnsafe }),
      },
    } as unknown as PrismaService;
    const service = new OvertimeExportService(prisma, {} as never);

    const result = await service.listRecords(new Set([7]), {}, 2, 10);

    expect(result).toMatchObject({
      data: [{
        id: 31,
        applicationNo: 'OT2026090401',
        employeeName: '张三',
        departmentNames: '研发部',
        positionName: '工程师',
        timeRange: '18:00 - 20:00',
        hours: 2,
        applicantName: '李四',
        submitterName: '王五',
        processorName: '赵六',
        status: 'APPROVED',
      }],
      pagination: { page: 2, pageSize: 10, totalItems: 1, totalPages: 1 },
    });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    const [, userIds, limit, offset] = queryRawUnsafe.mock.calls[1] as [string, number[], number, number];
    expect(userIds).toEqual([7]);
    expect([limit, offset]).toEqual([10, 10]);
  });
});
