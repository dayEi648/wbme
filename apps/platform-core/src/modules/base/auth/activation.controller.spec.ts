import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ROUTE_KEY } from '@wbme/server';
import { ActivationController } from './activation.controller';

/**
 * 激活接口路由元数据断言（base PRD §2、主 PRD §9.6）。
 * A6/A7 均发生在建立登录会话之前（凭证由一次性流程 Cookie 承接），
 * 必须标记 @Public()，否则被全局 SessionGuard 以 401 拦截（阶段 2 曾遗漏 A7）。
 */
describe('ActivationController 公开路由元数据', () => {
  it('A6 兑换与 A7 确认均为公开路由（跳过会话守卫）', () => {
    expect(Reflect.getMetadata(PUBLIC_ROUTE_KEY, ActivationController.prototype.redeem)).toBe(true);
    expect(Reflect.getMetadata(PUBLIC_ROUTE_KEY, ActivationController.prototype.confirm)).toBe(true);
  });
});
