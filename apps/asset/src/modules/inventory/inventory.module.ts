import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockFlowService } from './stock-flow.service';

/**
 * 库存条目/批次/流水模块（asset PRD §5）。
 */
@Module({
  controllers: [InventoryController],
  providers: [InventoryService, StockFlowService],
  exports: [InventoryService],
})
export class InventoryModule {}
