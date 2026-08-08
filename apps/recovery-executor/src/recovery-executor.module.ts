import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

/** 恢复执行器根模块（backstage PRD §10 恢复逻辑 T10-3 阶段落地） */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
})
export class RecoveryExecutorModule {}
