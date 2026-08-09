import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { HealthStatusController } from './health-status.controller';
import { HealthStatusService } from './health-status.service';

/** 健康状态聚合 API */
@Module({
  imports: [PermissionModule],
  controllers: [HealthStatusController],
  providers: [HealthStatusService],
})
export class HealthStatusModule {}
