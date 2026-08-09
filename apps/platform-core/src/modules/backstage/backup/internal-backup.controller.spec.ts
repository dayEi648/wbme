import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ALLOWED_CALLERS_KEY, PUBLIC_ROUTE_KEY } from '@wbme/server';
import { InternalBackupController } from './internal-backup.controller';

/**
 * 内部备份控制器路由元数据断言（主 PRD §9.4）。
 *
 * 内部端点必须：
 * 1. 标记 @Public() 跳过全局 SessionGuard（无用户会话）；
 * 2. 声明 @AllowedCallers('migration-runner') 限定调用方白名单。
 */
describe('InternalBackupController 内部路由元数据', () => {
  it('immediateBackup 为公开路由且仅允许 migration-runner 调用', () => {
    expect(Reflect.getMetadata(PUBLIC_ROUTE_KEY, InternalBackupController.prototype.immediateBackup)).toBe(true);
    expect(Reflect.getMetadata(ALLOWED_CALLERS_KEY, InternalBackupController.prototype.immediateBackup)).toEqual([
      'migration-runner',
    ]);
  });

  it('getBackupStatus 为公开路由且仅允许 migration-runner 调用', () => {
    expect(Reflect.getMetadata(PUBLIC_ROUTE_KEY, InternalBackupController.prototype.getBackupStatus)).toBe(true);
    expect(Reflect.getMetadata(ALLOWED_CALLERS_KEY, InternalBackupController.prototype.getBackupStatus)).toEqual([
      'migration-runner',
    ]);
  });
});
