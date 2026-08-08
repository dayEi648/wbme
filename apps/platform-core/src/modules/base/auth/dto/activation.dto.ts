import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { IdempotentDto } from '@wbme/contracts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password.service';

/** A6 兑换凭证（fragment 中的一次性凭证，仅此一次出现在请求体） */
export class RedeemTokenDto {
  /** 一次性激活/重置凭证（≤256 字符；不得出现在 URL path/query/日志） */
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  token!: string;
}

/** A7/A8 激活/注册确认：姓名、性别、密码 */
export class ConfirmProfileDto extends IdempotentDto {
  @IsString()
  @MaxLength(50)
  name!: string;

  @IsIn(['MALE', 'FEMALE'])
  gender!: 'MALE' | 'FEMALE';

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  /** 二次输入（base PRD §2：要求二次输入一致；后端强制，不依赖前端） */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  confirmPassword!: string;
}
