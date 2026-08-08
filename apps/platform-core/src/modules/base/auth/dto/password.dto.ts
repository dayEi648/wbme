import { IsString, MaxLength, MinLength } from 'class-validator';
import { IdempotentDto } from '@wbme/contracts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password.service';

/** A9 修改密码（登录态） */
export class ChangePasswordDto extends IdempotentDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;

  /** 二次输入（base PRD §2：要求二次输入一致；后端强制，不依赖前端） */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  confirmPassword!: string;
}

/** A10' 自助重置发起（已绑定钉钉账号凭手机号发起；未绑定账号统一提示） */
export class ResetInitiateDto extends IdempotentDto {
  /** 平台手机号（登录前统一规范化，国家/地区码 + 号码） */
  @IsString()
  @MaxLength(32)
  phone!: string;
}

/** A10 重置确认（重置流程 Cookie） */
export class ResetPasswordDto extends IdempotentDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;

  /** 二次输入（base PRD §2：要求二次输入一致；后端强制，不依赖前端） */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  confirmPassword!: string;
}

/** A12 自助换绑发起（登录态：验证平台密码后进入钉钉授权） */
export class SelfRebindDto extends IdempotentDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
