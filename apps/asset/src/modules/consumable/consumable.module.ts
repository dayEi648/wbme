import { Module } from '@nestjs/common';
import { ConsumableController } from './consumable.controller';
import { ConsumableService } from './consumable.service';

/**
 * 消耗品品种模块（asset PRD §5）。
 */
@Module({
  controllers: [ConsumableController],
  providers: [ConsumableService],
  exports: [ConsumableService],
})
export class ConsumableModule {}
