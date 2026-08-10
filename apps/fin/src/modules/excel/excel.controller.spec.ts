import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { FINANCE_MAINTAIN_FUNCTION_CODE, FINANCE_VIEW_FUNCTION_CODE, type DataScope } from '@wbme/contracts';
import { abortSignal, ExcelController } from './excel.controller';

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

/**
 * ExcelController 导出授权与范围校验（L24/L25）。
 *
 * controller 的权限面经跨 schema 只读视图查询（function_registry / user_accounts /
 * function_grants / user_org），测试以 SQL 关键字路由 mock $queryRaw，
 * 断言导出操作日志的功能编码按用户实际权限选择、非法 scope 使用独立错误码。
 */
describe('ExcelController 导出 feature 与 scope', () => {
  /** 构造按 SQL 关键字路由的 $queryRaw（grants 控制各功能码的数据范围授权） */
  function buildController(grants: Partial<Record<string, DataScope>>) {
    const $queryRaw = vi.fn(async (...args: unknown[]) => {
      const template = args[0] as TemplateStringsArray;
      const text = template.join('?');
      if (text.includes('function_registry')) {
        const code = args[1] as string;
        return [{ code, system_code: 'fin', system_name: '财务系统', product_status: 'OPEN' }];
      }
      if (text.includes('function_grants')) {
        // 模板两个插值（user_id、function_code）：function_code 是最后一个参数
        const code = args[args.length - 1] as string;
        return grants[code] ? [{ data_scope: grants[code] }] : [];
      }
      if (text.includes('user_accounts')) {
        if (text.includes('SELECT name')) {
          return [{ name: '导出测试员' }];
        }
        return [{ user_id: 1, status: 'ACTIVE', session_version: 1, is_super_admin: false, deleted_at: null }];
      }
      if (text.includes('user_org')) {
        return [];
      }
      return [];
    });
    const prisma = { client: { $queryRaw } };
    const exports = { export: vi.fn().mockResolvedValue(undefined) };
    const controller = new ExcelController(prisma as never, {} as never, exports as never);
    return { controller, exports };
  }

  it('L24 数据维护用户导出 → 操作日志功能编码为 finance_maintain', async () => {
    const { controller, exports } = buildController({ [FINANCE_MAINTAIN_FUNCTION_CODE]: 'COMPANY' });
    const { req, res } = mockReqRes();

    await controller.export(1, 'all', {} as never, req as Request, res as Response);

    expect(exports.export).toHaveBeenCalledTimes(1);
    expect(exports.export.mock.calls[0]?.[5]).toBe(FINANCE_MAINTAIN_FUNCTION_CODE);
  });

  it('L24 仅查看用户导出 → 操作日志功能编码为 finance_view', async () => {
    const { controller, exports } = buildController({ [FINANCE_VIEW_FUNCTION_CODE]: 'COMPANY' });
    const { req, res } = mockReqRes();

    await controller.export(1, 'all', {} as never, req as Request, res as Response);

    expect(exports.export).toHaveBeenCalledTimes(1);
    expect(exports.export.mock.calls[0]?.[5]).toBe(FINANCE_VIEW_FUNCTION_CODE);
  });

  it('L25 非法导出 scope → EXPORT_SCOPE_INVALID，不透传导出服务', async () => {
    const { controller, exports } = buildController({ [FINANCE_MAINTAIN_FUNCTION_CODE]: 'COMPANY' });
    const { req, res } = mockReqRes();

    await expect(controller.export(1, 'unknown', {} as never, req as Request, res as Response)).rejects.toMatchObject(
      { entry: { code: 'EXPORT_SCOPE_INVALID' } },
    );
    expect(exports.export).not.toHaveBeenCalled();
  });
});
