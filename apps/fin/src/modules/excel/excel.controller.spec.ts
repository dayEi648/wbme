import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { abortSignal } from './excel.controller';

/**
 * 模拟 Express Request/Response 的最小 EventEmitter 行为，
 * 用于验证 abortSignal 同时监听 req 'aborted' 与 res 'close'。
 */
function mockReqRes(): { req: EventEmitter & Partial<Request>; res: EventEmitter & Partial<Response> } {
  return { req: new EventEmitter(), res: new EventEmitter() } as never;
}

/**
 * Excel 控制器取消信号单元测试。
 *
 * 关键行为：取消信号必须来自响应侧（res 'close'），因为 Multer 读完请求体后
 * req 'close' 已不可靠；响应关闭（路由超时/客户端断开/代理断连）才代表客户端
 * 不再需要结果，此时应中止后续 worker 与数据库写入。
 */
describe('ExcelController abortSignal', () => {
  it('req aborted 时触发取消信号', () => {
    const { req, res } = mockReqRes();
    const signal = abortSignal(req as Request, res as Response);
    expect(signal?.aborted).toBe(false);
    req.emit('aborted');
    expect(signal?.aborted).toBe(true);
  });

  it('res close 时触发取消信号', () => {
    const { req, res } = mockReqRes();
    const signal = abortSignal(req as Request, res as Response);
    expect(signal?.aborted).toBe(false);
    res.emit('close');
    expect(signal?.aborted).toBe(true);
  });
});
