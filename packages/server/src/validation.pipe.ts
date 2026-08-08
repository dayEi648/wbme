import { ValidationPipe } from '@nestjs/common';

/**
 * 全局校验管道（主 PRD §9.6/§9.5）：
 * - whitelist：剥离未声明字段；
 * - forbidNonWhitelisted：出现未声明字段直接拒绝（白名单）；
 * - transform：按 DTO 声明转换类型（Query 参数需配合 @Type 显式转换）；
 * 转换失败不得进入业务服务。
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}
