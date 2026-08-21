import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { MenuConfigController } from './menu-config.controller';
import { MenuConfigService } from './menu-config.service';

/** 菜单管理模块（backstage；主 PRD §2.1）：四系统导航菜单展示配置的读取与整树维护 */
@Module({
  imports: [PermissionModule],
  controllers: [MenuConfigController],
  providers: [MenuConfigService],
})
export class MenuConfigModule {}
