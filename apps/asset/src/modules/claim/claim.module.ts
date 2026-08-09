import { forwardRef, Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { SettingsModule } from '../settings/settings.module';
import { AgentClaimController } from './agent-claim.controller';
import { AgentClaimService } from './agent-claim.service';
import { ClaimController } from './claim.controller';
import { ClaimService } from './claim.service';

/**
 * 消耗品申领模块（asset PRD §5/§7：普通申领 + 代交申领）。
 */
@Module({
  imports: [forwardRef(() => ApprovalModule), SettingsModule],
  controllers: [ClaimController, AgentClaimController],
  providers: [ClaimService, AgentClaimService],
  exports: [ClaimService, AgentClaimService],
})
export class ClaimModule {}
