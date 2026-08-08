import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IdempotentDto } from '@wbme/contracts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password.service';

/** 手机号 + 密码登录（A1，base PRD §2/§4） */
export class LoginPasswordDto extends IdempotentDto {
  /** 手机号（登录前统一规范化，国家/地区码 + 号码） */
  @IsString()
  @MaxLength(32)
  phone!: string;

  /** 平台密码（8~32 字符） */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  /** 记住我：延长空闲与绝对过期时限（不取消绝对过期） */
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
