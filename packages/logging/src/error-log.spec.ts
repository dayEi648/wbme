import { describe, expect, it, vi } from 'vitest';
import type { RawSqlClient } from './raw-sql-client';
import {
  bucketStart,
  computeErrorFingerprint,
  desensitizeErrorSample,
  upsertErrorLog,
} from './error-log';

describe('computeErrorFingerprint', () => {
  it('相同输入产生相同 SHA-256 十六进制', () => {
    const input = {
      service: 'platform-core',
      deployCommit: 'abc123',
      errorCategory: 'SYSTEM',
      entryPoint: 'GET /api/v1/users/:id',
      stackLocation: 'user.service.ts:42',
    };
    const a = computeErrorFingerprint(input);
    const b = computeErrorFingerprint(input);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不同入口产生不同指纹', () => {
    const base = {
      service: 'platform-core',
      deployCommit: 'abc123',
      errorCategory: 'SYSTEM',
      stackLocation: 'user.service.ts:42',
    };
    const a = computeErrorFingerprint({ ...base, entryPoint: 'GET /a' });
    const b = computeErrorFingerprint({ ...base, entryPoint: 'GET /b' });
    expect(a).not.toBe(b);
  });
});

describe('bucketStart', () => {
  it('向下取整到 UTC 五分钟桶', () => {
    const date = new Date('2026-08-09T10:07:30.000Z');
    expect(bucketStart(date).toISOString()).toBe('2026-08-09T10:05:00.000Z');
  });

  it('整五分钟边界保持不变', () => {
    const date = new Date('2026-08-09T10:05:00.000Z');
    expect(bucketStart(date).toISOString()).toBe('2026-08-09T10:05:00.000Z');
  });
});

describe('desensitizeErrorSample', () => {
  it('剥离密码与令牌模式', () => {
    const raw = 'failed: password=secret123 token=abc bearer xyz';
    const result = desensitizeErrorSample(raw);
    expect(result).not.toContain('secret123');
    expect(result).toContain('[REDACTED]');
  });

  it('超长文本截断', () => {
    const raw = 'x'.repeat(5000);
    const result = desensitizeErrorSample(raw);
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain('[truncated]');
  });
});

describe('upsertErrorLog', () => {
  it('写入成功返回 true', async () => {
    const client: RawSqlClient = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
      $queryRawUnsafe: vi.fn(),
    };
    const ok = await upsertErrorLog(client, {
      level: 'ERROR',
      service: 'platform-core',
      source: 'GET /api/v1/test',
      errorCategory: 'SYSTEM',
      deployCommit: 'abc',
      fingerprint: 'fp',
      bucketStart: new Date('2026-08-09T10:05:00.000Z'),
      occurredAt: new Date('2026-08-09T10:06:00.000Z'),
      requestId: 'req-1',
      sample: 'boom',
    });
    expect(ok).toBe(true);
    expect(client.$executeRawUnsafe).toHaveBeenCalledOnce();
  });

  it('写入失败返回 false 不抛错', async () => {
    const client: RawSqlClient = {
      $executeRawUnsafe: vi.fn().mockRejectedValue(new Error('db down')),
      $queryRawUnsafe: vi.fn(),
    };
    const ok = await upsertErrorLog(client, {
      level: 'ERROR',
      service: 'platform-core',
      source: 'GET /api/v1/test',
      errorCategory: 'SYSTEM',
      deployCommit: 'abc',
      fingerprint: 'fp',
      bucketStart: new Date(),
      occurredAt: new Date(),
      requestId: null,
      sample: 'boom',
    });
    expect(ok).toBe(false);
  });
});
