import { Module } from '@nestjs/common';
import { PermissionCatalogService } from './permission-catalog.service';

/**
 * 权限目录模块（backstage，实现规划 T3-1）。
 *
 * 启动时对账代码目录与数据库注册表；员工授权 CRUD（T3-2）、
 * 权限组（T3-3）与守卫（T3-4）在后续任务加入本领域。
 */
@Module({
  providers: [PermissionCatalogService],
  exports: [PermissionCatalogService],
})
export class PermissionCatalogModule {}
