import { Body, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { IdempotentDto } from '@wbme/contracts';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { IdempotencyHeaderInterceptor } from './idempotency-header.interceptor';

class WriteDto extends IdempotentDto {}

class PlainDto {
  value!: string;
}

class IdempotentController {
  write(@Body() _body: WriteDto): void {}
}

class PlainController {
  write(@Body() _body: PlainDto): void {}
}

function executionContext(
  controller: object,
  request: { body?: unknown; headers: Record<string, string | string[] | undefined> },
): ExecutionContext {
  return {
    getClass: () => controller.constructor,
    getHandler: () => (controller as { write: () => void }).write,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function callHandler(): CallHandler {
  return { handle: vi.fn(() => of({ ok: true })) };
}

describe('IdempotencyHeaderInterceptor', () => {
  it('仅为声明 IdempotentDto 的路由补齐请求头中的幂等键', () => {
    const request = { body: { value: 'x' }, headers: { 'idempotency-key': 'intent-1' } };
    const next = callHandler();

    new IdempotencyHeaderInterceptor().intercept(executionContext(new IdempotentController(), request), next);

    expect(request.body).toEqual({ value: 'x', idempotencyKey: 'intent-1' });
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('保留调用方显式提交的 body 幂等键', () => {
    const request = { body: { idempotencyKey: 'body-key' }, headers: { 'idempotency-key': 'header-key' } };

    new IdempotencyHeaderInterceptor().intercept(executionContext(new IdempotentController(), request), callHandler());

    expect(request.body).toEqual({ idempotencyKey: 'body-key' });
  });

  it('不会向非幂等 DTO 注入未知字段，保持白名单校验有效', () => {
    const request = { body: { value: 'x' }, headers: { 'idempotency-key': 'intent-1' } };

    new IdempotencyHeaderInterceptor().intercept(executionContext(new PlainController(), request), callHandler());

    expect(request.body).toEqual({ value: 'x' });
  });
});
