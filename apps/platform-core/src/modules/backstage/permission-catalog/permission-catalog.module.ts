import { Module } from '@nestjs/common';
import { PermissionCatalogService } from './permission-catalog.service';

/**
 * 权限目录模块（backstage）。
 *
 * 启动时对账代码目录与数据库注册表；员工授权 CRUD。
 */
@Module({
  providers: [PermissionCatalogService],
  exports: [PermissionCatalogService],
})
export class PermissionCatalogModule {}
