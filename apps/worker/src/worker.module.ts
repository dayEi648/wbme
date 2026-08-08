import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

/** Worker 根模块（统一后台任务消费逻辑 T4-2 阶段落地） */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
})
export class WorkerModule {}
