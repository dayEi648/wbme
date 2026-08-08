import { Module } from '@nestjs/common';
import { PermissionModule } from '../../backstage/permission/permission.module';
import { SettingsModule } from '../settings/settings.module';
import { SecurityLogModule } from '../security-log/security-log.module';
import { LoginProtectionModule } from '../login-protection/login-protection.module';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { PhoneSyncService } from './phone-sync.service';
import { AuthService } from './auth.service';
import { FlowSessionService } from './flows/flow-session.service';
import { ActivationFlow } from './flows/activation.flow';
import { RegistrationFlow } from './flows/registration.flow';
import { ResetFlow } from './flows/reset.flow';
import { AdminInvitationService } from './admin-invitation.service';
import { AuthController } from './auth.controller';
import { AdminAuthController } from './admin-auth.controller';
import { ActivationController } from './activation.controller';
import { RegistrationController } from './registration.controller';
import { PasswordController } from './password.controller';

/** base 认证模块（登录/登出/当前身份/激活/注册/邀请/改密/重置/解锁，T2-2~T2-5） */
@Module({
  imports: [SettingsModule, SecurityLogModule, LoginProtectionModule, PermissionModule],
  providers: [
    PasswordService,
    TokenService,
    PhoneSyncService,
    AuthService,
    FlowSessionService,
    ActivationFlow,
    RegistrationFlow,
    ResetFlow,
    AdminInvitationService,
  ],
  controllers: [
    AuthController,
    AdminAuthController,
    ActivationController,
    RegistrationController,
    PasswordController,
  ],
  exports: [PasswordService, AuthService, FlowSessionService, TokenService, PhoneSyncService],
})
export class AuthModule {}
