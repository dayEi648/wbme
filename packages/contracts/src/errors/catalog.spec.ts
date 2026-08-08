import { describe, expect, it } from 'vitest';
import { BusinessException } from './business-exception';
import { ERROR_CATALOG, getErrorEntry } from './catalog';
import { HTTP_STATUS_BY_TYPE, type ErrorEntry } from './types';
import { frameworkErrors } from './domains/framework';
import { exportErrors } from './domains/export';

describe('错误目录契约（主 PRD §9.6）', () => {
  it('所有目录项 code 在 (type, domain) 内唯一', () => {
    for (const [domain, entries] of Object.entries(ERROR_CATALOG)) {
      const seen = new Map<string, string>();
      for (const entry of entries) {
        const key = `${entry.type}:${entry.code}`;
        expect(seen.has(key), `${domain} 中重复的错误码 ${key}`).toBe(false);
        seen.set(key, entry.message);
      }
    }
  });

  it('BUSINESS 类型必须携带业务域，且 httpStatus 属于该类型允许集合', () => {
    for (const entries of Object.values(ERROR_CATALOG)) {
      for (const entry of entries) {
        if (entry.type === 'BUSINESS') {
          expect(entry.domain, `${entry.code} 缺少业务域`).toBeDefined();
        }
        expect(HTTP_STATUS_BY_TYPE[entry.type]).toContain(entry.httpStatus);
        expect(entry.message.trim().length, `${entry.code} 文案为空`).toBeGreaterThan(0);
      }
    }
  });

  it('framework 目录不应携带业务域（通用错误无 domain）', () => {
    for (const entry of Object.values(frameworkErrors) as readonly ErrorEntry[]) {
      expect(entry.domain).toBeUndefined();
    }
  });

  it('已契约的关键错误码可被精确查询（域内唯一、状态映射存在）', () => {
    // 主 PRD §9.6 示例：BUSINESS + INVENTORY + INSUFFICIENT_STOCK
    expect(getErrorEntry('BUSINESS', 'INVENTORY', 'INSUFFICIENT_STOCK')?.httpStatus).toBe(422);
    // 主 PRD §10.3：BUSINESS + EXPORT + ROW_LIMIT_EXCEEDED
    expect(getErrorEntry('BUSINESS', 'EXPORT', 'ROW_LIMIT_EXCEEDED')?.httpStatus).toBe(422);
    // 主 PRD §3.3：409 IDEMPOTENCY_KEY_REUSED（无域）
    expect(getErrorEntry('CONFLICT', undefined, 'IDEMPOTENCY_KEY_REUSED')?.httpStatus).toBe(409);
    // backstage PRD §3：DEPENDENCY + HR_SERVICE_UNAVAILABLE
    expect(getErrorEntry('DEPENDENCY', 'INTEGRATION', 'HR_SERVICE_UNAVAILABLE')?.httpStatus).toBe(503);
  });

  it('未注册的错误码查询返回 undefined', () => {
    expect(getErrorEntry('BUSINESS', 'HR', 'NOT_EXIST_CODE')).toBeUndefined();
  });
});

describe('BusinessException（主 PRD §9.6）', () => {
  it('携带目录项与白名单过滤后的详情，不暴露白名单外键', () => {
    const exception = new BusinessException(exportErrors.ROW_LIMIT_EXCEEDED, {
      actualRows: 120000,
      limit: 100000,
      // 白名单外键应被过滤，防止泄露内部信息
      querySql: 'select * from projects',
    });
    expect(exception.entry.code).toBe('ROW_LIMIT_EXCEEDED');
    expect(exception.details).toEqual({ actualRows: 120000, limit: 100000 });
  });

  it('未声明白名单时详情恒为 undefined', () => {
    const exception = new BusinessException(frameworkErrors.FORBIDDEN, { userId: 1 });
    expect(exception.details).toBeUndefined();
  });
});
