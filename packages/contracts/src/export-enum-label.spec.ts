import { describe, expect, it } from 'vitest';
import { formatExportEnumLabel } from './export-enum-label';

describe('formatExportEnumLabel', () => {
  it('将审批和节假日枚举转换为中文', () => {
    expect(formatExportEnumLabel('approvalStatus', 'APPROVED')).toBe('已批准');
    expect(formatExportEnumLabel('holidayDateType', 'WORKDAY')).toBe('工作日');
    expect(formatExportEnumLabel('hrRequestType', 'OVERTIME')).toBe('加班申请');
    expect(formatExportEnumLabel('assetRequestType', 'STOCK_IN')).toBe('入库申请');
    expect(formatExportEnumLabel('assetStatus', 'IN_USE')).toBe('使用中');
    expect(formatExportEnumLabel('stockFlowType', 'TRANSFER_OUT')).toBe('调出');
    expect(formatExportEnumLabel('flowDirection', 'OUT')).toBe('出库');
    expect(formatExportEnumLabel('operationAction', 'EXPORT')).toBe('导出');
    expect(formatExportEnumLabel('systemCode', 'HR')).toBe('人事系统');
    expect(formatExportEnumLabel('logLevel', 'ERROR')).toBe('错误');
    expect(formatExportEnumLabel('errorStatus', 'HANDLED')).toBe('已处理');
    expect(formatExportEnumLabel('securityEventType', 'LOGIN_SUCCESS')).toBe('登录成功');
    expect(formatExportEnumLabel('securityResult', 'SUCCESS')).toBe('成功');
  });

  it('不向导出文件回显未知的内部枚举编码', () => {
    expect(formatExportEnumLabel('approvalStatus', 'UNRECOGNIZED')).toBe('未知');
    expect(formatExportEnumLabel('approvalStatus', null)).toBe('');
  });
});
