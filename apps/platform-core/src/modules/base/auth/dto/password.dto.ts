import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
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

  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  confirmPassword?: string;
}

/** A10 重置确认（重置流程 Cookie） */
export class ResetPasswordDto extends IdempotentDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;

  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  confirmPassword?: string;
}

/** A12 自助换绑发起（登录态：验证平台密码后进入钉钉授权） */
export class SelfRebindDto extends IdempotentDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
