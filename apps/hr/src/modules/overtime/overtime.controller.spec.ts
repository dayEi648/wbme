import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import type { DepartmentClosureService } from '../../shared/department-closure.service';
import type { HolidayAdapter } from '../holiday/holiday.adapter';
import type { HrApprovalService } from '../approval/hr-approval.service';
import { OvertimeController } from './overtime.controller';
import type { OvertimeExportService } from './overtime-export.service';
import type { OvertimeSubmissionService } from './overtime-submission.service';
import type { OvertimeSummaryService } from './overtime-summary.service';

interface MockOvertimeItem {
  id: number;
  overtimeDate: Date;
  startMinute: number;
  endMinute: number;
  reason: string;
  holidaySnapshot: object;
  requestId: number;
  request: { applicationNo: string };
}

function createController(findManyResult: MockOvertimeItem[]) {
  const mockPrisma = {
    client: {
      overtimeItem: {
        findMany: vi.fn().mockResolvedValue(findManyResult),
      },
    },
  } as unknown as PrismaService;

  const controller = new OvertimeController(
    mockPrisma,
    {} as OvertimeSubmissionService,
    {} as HrApprovalService,
    {} as OvertimeSummaryService,
    {} as OvertimeExportService,
    {} as DepartmentClosureService,
    {} as HolidayAdapter,
  );

  return { controller, mockPrisma };
}

function baseItem(overrides: { id: number; overtimeDate: string; startMinute: number; endMinute: number }): MockOvertimeItem {
  return {
    id: overrides.id,
    overtimeDate: new Date(overrides.overtimeDate),
    startMinute: overrides.startMinute,
    endMinute: overrides.endMinute,
    reason: `reason-${overrides.id}`,
    holidaySnapshot: { dateType: '工作日' },
    requestId: overrides.id,
    request: { applicationNo: `OT-${overrides.id}` },
  };
}

describe('OvertimeController.mine', () => {
  it('按 overtimeDate 升序排序覆盖数据库默认顺序', async () => {
    const { controller } = createController([
      baseItem({ id: 1, overtimeDate: '2026-08-20', startMinute: 600, endMinute: 720 }),
      baseItem({ id: 2, overtimeDate: '2026-08-19', startMinute: 540, endMinute: 600 }),
    ]);

    const result = await controller.mine(1, {
      sorts: JSON.stringify([{ field: 'overtimeDate', direction: 'ASC' }]),
    } as Parameters<OvertimeController['mine']>[1]);

    expect((result as { data: Array<{ id: number }> }).data.map((item) => item.id)).toEqual([2, 1]);
  });

  it('按 minutes 升序排序', async () => {
    const { controller } = createController([
      baseItem({ id: 1, overtimeDate: '2026-08-20', startMinute: 600, endMinute: 720 }), // 120 分钟
      baseItem({ id: 2, overtimeDate: '2026-08-19', startMinute: 540, endMinute: 600 }), // 60 分钟
    ]);

    const result = await controller.mine(1, {
      sorts: JSON.stringify([{ field: 'minutes', direction: 'ASC' }]),
    } as Parameters<OvertimeController['mine']>[1]);

    expect((result as { data: Array<{ id: number }> }).data.map((item) => item.id)).toEqual([2, 1]);
  });

  it('未注册排序字段返回 400', async () => {
    const { controller } = createController([
      baseItem({ id: 1, overtimeDate: '2026-08-20', startMinute: 600, endMinute: 720 }),
      baseItem({ id: 2, overtimeDate: '2026-08-19', startMinute: 540, endMinute: 600 }),
    ]);

    await expect(
      controller.mine(1, {
        sorts: JSON.stringify([{ field: 'reason', direction: 'ASC' }]),
      } as Parameters<OvertimeController['mine']>[1]),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('无排序时保持数据库默认顺序', async () => {
    const { controller } = createController([
      baseItem({ id: 1, overtimeDate: '2026-08-20', startMinute: 600, endMinute: 720 }),
      baseItem({ id: 2, overtimeDate: '2026-08-19', startMinute: 540, endMinute: 600 }),
    ]);

    const result = await controller.mine(1, {} as Parameters<OvertimeController['mine']>[1]);

    expect((result as { data: Array<{ id: number }> }).data.map((item) => item.id)).toEqual([1, 2]);
  });
});
