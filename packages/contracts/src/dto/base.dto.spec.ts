import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { PaginationQueryDto } from './base.dto';
import { AssetCreateDto } from './fixed-asset.dto';
import { OvertimeSubmitDto } from './overtime.dto';

/** 通用表格查询契约：筛选与排序只能使用受控 JSON 结构，字段含义由资源白名单决定。 */
describe('PaginationQueryDto（结构化表格查询）', () => {
  it('接受简单条件、日期区间、条件组和多级排序', async () => {
    const dto = plainToInstance(PaginationQueryDto, {
      filters: JSON.stringify({
        logic: 'OR',
        groups: [
          { logic: 'AND', conditions: [{ field: 'name', operator: 'CONTAINS', value: '设备' }] },
          { logic: 'AND', conditions: [{ field: 'purchaseAt', operator: 'BETWEEN', value: '2026-01-01', valueEnd: '2026-01-31' }] },
        ],
      }),
      sorts: JSON.stringify([{ field: 'updatedAt', direction: 'DESC' }, { field: 'id', direction: 'ASC' }]),
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('拒绝未声明操作符、错误区间和值不是字符串的载荷', async () => {
    const invalidFilters = [
      { logic: 'AND', conditions: [{ field: 'name', operator: 'RAW_SQL', value: 'x' }] },
      { logic: 'AND', conditions: [{ field: 'purchaseAt', operator: 'BETWEEN', value: '2026-01-01' }] },
      { logic: 'AND', conditions: [{ field: 'id', operator: 'EQUALS', value: 1 }] },
    ];
    for (const filters of invalidFilters) {
      const dto = plainToInstance(PaginationQueryDto, { filters: JSON.stringify(filters) });
      expect(await validate(dto)).not.toHaveLength(0);
    }
  });

  it('接受树形条件组（根组内混合条件与直接子组）', async () => {
    const dto = plainToInstance(PaginationQueryDto, {
      filters: JSON.stringify({
        logic: 'AND',
        conditions: [
          { field: 'name', operator: 'STARTS_WITH', value: '设备' },
          {
            logic: 'OR',
            conditions: [
              { field: 'status', operator: 'EQUALS', value: 'IDLE' },
              { field: 'purchaseAt', operator: 'BETWEEN', value: '2026-01-01', valueEnd: '2026-01-31' },
            ],
          },
        ],
      }),
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('兼容旧平铺与旧条件组两种历史形状', async () => {
    const legacyPayloads = [
      { logic: 'OR', conditions: [{ field: 'name', operator: 'CONTAINS', value: '设备' }] },
      {
        logic: 'OR',
        groups: [{ logic: 'AND', conditions: [{ field: 'name', operator: 'ENDS_WITH', value: '号' }] }],
      },
    ];
    for (const filters of legacyPayloads) {
      const dto = plainToInstance(PaginationQueryDto, { filters: JSON.stringify(filters) });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('接受无值操作符传空字符串的载荷', async () => {
    for (const operator of ['IS_EMPTY', 'IS_NOT_EMPTY', 'TODAY', 'THIS_WEEK', 'THIS_MONTH', 'THIS_YEAR', 'LAST_7_DAYS', 'LAST_30_DAYS']) {
      const dto = plainToInstance(PaginationQueryDto, {
        filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'createdAt', operator, value: '' }] }),
      });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('拒绝三层组嵌套（子组内再含子组）', async () => {
    const dto = plainToInstance(PaginationQueryDto, {
      filters: JSON.stringify({
        logic: 'AND',
        conditions: [
          {
            logic: 'OR',
            conditions: [{ logic: 'AND', conditions: [{ field: 'name', operator: 'EQUALS', value: 'x' }] }],
          },
        ],
      }),
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('拒绝子组内的未知操作符', async () => {
    const dto = plainToInstance(PaginationQueryDto, {
      filters: JSON.stringify({
        logic: 'AND',
        conditions: [{ logic: 'OR', conditions: [{ field: 'name', operator: 'RAW_SQL', value: 'x' }] }],
      }),
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('拒绝子组数量超过上限的树形载荷', async () => {
    const conditions = Array.from({ length: 11 }, () => ({
      logic: 'AND',
      conditions: [{ field: 'name', operator: 'EQUALS', value: 'x' }],
    }));
    const dto = plainToInstance(PaginationQueryDto, { filters: JSON.stringify({ logic: 'AND', conditions }) });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('拒绝总条件数超过上限的载荷', async () => {
    const overLimitPayloads = [
      { logic: 'AND', conditions: Array.from({ length: 101 }, (_, index) => ({ field: `f${index}`, operator: 'EQUALS', value: 'x' })) },
      {
        logic: 'AND',
        conditions: [
          { field: 'name', operator: 'EQUALS', value: 'x' },
          { logic: 'OR', conditions: Array.from({ length: 100 }, (_, index) => ({ field: `f${index}`, operator: 'EQUALS', value: 'x' })) },
        ],
      },
    ];
    for (const filters of overLimitPayloads) {
      const dto = plainToInstance(PaginationQueryDto, { filters: JSON.stringify(filters) });
      expect(await validate(dto)).not.toHaveLength(0);
    }
  });

  it('拒绝错误排序方向与空排序列表', async () => {
    for (const sorts of [[], [{ field: 'id', direction: 'DROP' }]]) {
      const dto = plainToInstance(PaginationQueryDto, { sorts: JSON.stringify(sorts) });
      expect(await validate(dto)).not.toHaveLength(0);
    }
  });

  it('执行共享金额与跨字段时间校验，而非仅登记装饰器元数据', async () => {
    const invalidAsset = plainToInstance(AssetCreateDto, { name: '测试资产', amount: '1e3', ownership: 'COMPANY' });
    const invalidOvertime = plainToInstance(OvertimeSubmitDto, {
      overtimeDate: '2026-08-09',
      startMinute: 600,
      endMinute: 600,
      reason: '测试',
      userIds: [1],
    });

    expect((await validate(invalidAsset)).some((error) => error.property === 'amount')).toBe(true);
    expect((await validate(invalidOvertime)).some((error) => error.property === 'startMinute')).toBe(true);
  });
});
