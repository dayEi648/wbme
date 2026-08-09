import { describe, expect, it } from 'vitest';
import { formatOperationSummary } from './operation-log';

describe('formatOperationSummary', () => {
  it('按统一模板生成摘要', () => {
    const summary = formatOperationSummary({
      operatorName: '张三',
      system: '资产系统',
      feature: '固定资产维护',
      actionType: 'CREATE',
      detail: '固定资产 XXX',
    });
    expect(summary).toBe('张三在资产系统的固定资产维护中新增了固定资产 XXX');
  });

  it('导出操作使用导出动词', () => {
    const summary = formatOperationSummary({
      operatorName: '李四',
      system: '管理后台',
      feature: '操作日志',
      actionType: 'EXPORT',
      detail: '操作日志列表',
    });
    expect(summary).toBe('李四在管理后台的操作日志中导出了操作日志列表');
  });
});
