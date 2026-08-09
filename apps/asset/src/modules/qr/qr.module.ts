import { Module } from '@nestjs/common';
import { RateLimitGuard } from '@wbme/server';
import { QrController } from './qr.controller';
import { QrService } from './qr.service';

/**
 * 二维码模块（asset PRD §11）。
 */
@Module({
  controllers: [QrController],
  providers: [QrService, RateLimitGuard],
  exports: [QrService],
})
export class QrModule {}
