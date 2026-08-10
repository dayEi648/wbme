import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { SystemStructureController } from './system-structure.controller';
import { SystemStructureService } from './system-structure.service';

/** 系统开放状态管理模块（backstage PRD §6） */
@Module({
  imports: [PermissionModule],
  controllers: [SystemStructureController],
  providers: [SystemStructureService],
})
export class SystemStructureModule {}
