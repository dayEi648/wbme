import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import {
  BusinessException,
  frameworkErrors,
  type BusinessDomain,
  type ErrorEntry,
  type ErrorType,
} from '@wbme/contracts';
import { getRequestContext } from './request-context';

/**
 * 单一全局异常过滤器（主 PRD §9.6）。
 *
 * 按确定顺序识别并映射异常：
 * BusinessException → DTO/管道校验 → 认证 → 授权 → 已知状态/唯一性冲突 →
 * 限流 → 本服务操作超时 → 依赖异常 → 未知异常。
 * 不得串联多个可能捕获同一异常的过滤器；响应不包含堆栈、SQL、文件路径或密钥。
 */

/** 依赖异常识别接口：Redis/OSS/数据库连接或下游服务不可用/超时（T0-5 起按各依赖细化） */
export interface DependencyExceptionDetector {
  /** 判断异常是否属于依赖（不可用或超时） */
  isDependencyException(exception: unknown): boolean;
}

/** 常见依赖错误信号（挂载点默认实现，后续阶段可按具体客户端补充） */
const DEPENDENCY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);

const DEPENDENCY_ERROR_NAMES = new Set(['TimeoutError', 'ConnectionError', 'NR_CLUSTER', 'NR_SOCKET']);

export const defaultDependencyDetector: DependencyExceptionDetector = {
  isDependencyException(exception) {
    const code = (exception as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && DEPENDENCY_ERROR_CODES.has(code)) {
      return true;
    }
    const name = (exception as { name?: unknown } | null)?.name;
    return typeof name === 'string' && DEPENDENCY_ERROR_NAMES.has(name);
  },
};

/** 统一错误响应结构（主 PRD §9.5） */
export interface ErrorResponseBody {
  error: {
    type: ErrorType;
    domain?: BusinessDomain;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

/** class-validator 管道抛出的字段错误明细 */
interface FieldError {
  field: string;
  errors: string[];
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly dependencyDetector: DependencyExceptionDetector = defaultDependencyDetector) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = this.mapException(exception);
    const requestId = getRequestContext()?.requestId ?? randomUUID();

    const body: ErrorResponseBody = {
      error: {
        type: mapped.entry.type,
        ...(mapped.entry.domain ? { domain: mapped.entry.domain } : {}),
        code: mapped.entry.code,
        message: mapped.entry.message,
        ...(mapped.details ? { details: mapped.details } : {}),
        requestId,
      },
    };
    response.status(mapped.entry.httpStatus).json(body);
  }

  private mapException(exception: unknown): { entry: ErrorEntry; details?: Record<string, unknown> } {
    // 1. 业务异常：目录映射（不包裹程序/基础设施故障）
    if (exception instanceof BusinessException) {
      return { entry: exception.entry, details: exception.details };
    }

    // 2. DTO/管道校验异常：字段校验失败
    if (exception instanceof BadRequestException) {
      return this.mapBadRequest(exception);
    }

    // 3. 认证异常
    if (exception instanceof UnauthorizedException) {
      return { entry: frameworkErrors.UNAUTHORIZED };
    }

    // 4. 授权异常
    if (exception instanceof ForbiddenException) {
      return { entry: frameworkErrors.FORBIDDEN };
    }

    // 5. 已知状态或唯一性冲突
    if (exception instanceof ConflictException) {
      return { entry: frameworkErrors.CONFLICT };
    }

    // 6. 依赖异常：Redis/OSS/数据库连接或下游服务不可用/超时
    if (this.dependencyDetector.isDependencyException(exception)) {
      return { entry: frameworkErrors.DEPENDENCY_UNAVAILABLE };
    }

    // 7. 其它 HttpException：按 HTTP 状态映射为稳定类型（未知消息不得透传）
    if (exception instanceof HttpException) {
      return this.mapHttpException(exception);
    }

    // 8. 未知异常：SYSTEM 500 通用安全文案（T4-3 起在此追加集中系统日志）
    return { entry: frameworkErrors.INTERNAL_ERROR };
  }

  /** 校验管道异常：提取字段级错误到白名单 details.fields */
  private mapBadRequest(exception: BadRequestException): { entry: ErrorEntry; details?: Record<string, unknown> } {
    const payload = exception.getResponse();
    const message = typeof payload === 'object' && payload !== null ? (payload as { message?: unknown }).message : undefined;
    if (Array.isArray(message)) {
      const fields = extractFieldErrors(message);
      return { entry: frameworkErrors.VALIDATION_FAILED, details: fields.length > 0 ? { fields } : undefined };
    }
    return { entry: frameworkErrors.VALIDATION_FAILED };
  }

  /** 其它 HttpException：按状态映射稳定错误类型，不透传原始 message */
  private mapHttpException(exception: HttpException): { entry: ErrorEntry } {
    const status = exception.getStatus();
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return { entry: frameworkErrors.UNAUTHORIZED };
      case HttpStatus.FORBIDDEN:
        return { entry: frameworkErrors.FORBIDDEN };
      case HttpStatus.NOT_FOUND:
        return { entry: frameworkErrors.RESOURCE_NOT_FOUND };
      case HttpStatus.CONFLICT:
        return { entry: frameworkErrors.CONFLICT };
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return { entry: frameworkErrors.PAYLOAD_TOO_LARGE };
      case HttpStatus.TOO_MANY_REQUESTS:
        return { entry: frameworkErrors.RATE_LIMITED };
      default:
        return { entry: frameworkErrors.INTERNAL_ERROR };
    }
  }
}

/**
 * 从校验错误提取 { field, errors[] }（白名单结构）。
 * 兼容两种形式：class-validator 结构化 ValidationError（属性校验失败），
 * 以及 forbidNonWhitelisted 的 "property <prop> should not exist" 字符串消息。
 */
function extractFieldErrors(messages: unknown[]): FieldError[] {
  const fields: FieldError[] = [];
  for (const item of messages) {
    if (typeof item === 'object' && item !== null) {
      const record = item as { property?: unknown; constraints?: Record<string, string> | undefined };
      if (typeof record.property === 'string' && record.constraints) {
        fields.push({ field: record.property, errors: Object.values(record.constraints) });
        continue;
      }
    }
    if (typeof item === 'string') {
      const match = /^property (\S+) should not exist/.exec(item);
      // 正则固定含一个捕获组，匹配成功时 group 1 必存在
      if (match?.[1]) {
        fields.push({ field: match[1], errors: [item] });
      }
    }
  }
  return fields;
}
