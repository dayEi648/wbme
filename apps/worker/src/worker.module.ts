import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WorkerRuntimeService } from './worker-runtime.service';

/** Worker 根模块（统一后台任务 Outbox + BullMQ 消费） */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [WorkerRuntimeService],
})
export class WorkerModule {}
