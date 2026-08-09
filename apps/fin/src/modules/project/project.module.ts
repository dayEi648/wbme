import { Module } from '@nestjs/common';
import { ProjectController, ProjectOperationController } from './project.controller';
import { DetailService } from './detail.service';
import { ProjectOperationService } from './project-operation.service';
import { ProjectService } from './project.service';

/**
 * 项目主档模块：工程合同、金额明细、项目操作记录。
 */
@Module({
  controllers: [ProjectController, ProjectOperationController],
  providers: [ProjectService, DetailService, ProjectOperationService],
  exports: [ProjectService],
})
export class ProjectModule {}
