import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { SecurityLogModule } from '../security-log/security-log.module';
import { LoginProtectionService } from './login-protection.service';

/** 登录保护模块（base PRD §4：账号锁 + IP 锁） */
@Module({
  imports: [SettingsModule, SecurityLogModule],
  providers: [LoginProtectionService],
  exports: [LoginProtectionService],
})
export class LoginProtectionModule {}
