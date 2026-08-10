import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import {
  BusinessException,
  financeErrors,
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

/** 依赖异常识别接口：Redis/OSS/数据库连接或下游服务不可用/超时（按各依赖细化） */
export interface DependencyExceptionDetector {
  /** 判断异常是否属于依赖（不可用或超时） */
  isDependencyException(exception: unknown): boolean;
}

/** 集中错误日志写入回调（fire-and-forget，不阻塞响应） */
export interface ErrorLogWriter {
  /**
   * 异步写入或聚合系统/依赖未知异常。
   * 实现方应自行捕获异常，不得向上抛出。
   */
  write(input: {
    errorCategory: 'SYSTEM' | 'DEPENDENCY';
    exception: unknown;
    requestId: string;
    service: string;
    source: string;
    deployCommit: string;
    occurredAt: Date;
  }): void;
}

/** 常见依赖错误信号（挂载点默认实现，可按具体客户端补充） */
const DEPENDENCY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);

const DEPENDENCY_ERROR_NAMES = new Set(['TimeoutError', 'ConnectionError', 'NR_CLUSTER', 'NR_SOCKET', 'InternalRequestError']);

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
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(
    private readonly dependencyDetector: DependencyExceptionDetector = defaultDependencyDetector,
    private readonly errorLogWriter?: ErrorLogWriter,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = this.mapException(exception);
    const requestId = getRequestContext()?.requestId ?? randomUUID();

    this.maybeWriteErrorLog(exception, mapped.entry, requestId, host);

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

  /**
   * 系统/依赖未知异常 fire-and-forget 写入集中错误日志。
   * 不阻塞 HTTP 响应。source 取规范化路由模板（backstage PRD §8）。
   */
  private maybeWriteErrorLog(
    exception: unknown,
    entry: ErrorEntry,
    requestId: string,
    host: ArgumentsHost,
  ): void {
    if (!this.errorLogWriter) {
      return;
    }
    const isDependency = this.dependencyDetector.isDependencyException(exception);
    const isSystemUnknown =
      !isDependency &&
      !(exception instanceof BusinessException) &&
      !(exception instanceof BadRequestException) &&
      !(exception instanceof UnauthorizedException) &&
      !(exception instanceof ForbiddenException) &&
      !(exception instanceof ConflictException) &&
      !(exception instanceof HttpException) &&
      entry.code === frameworkErrors.INTERNAL_ERROR.code;
    if (!isDependency && !isSystemUnknown) {
      return;
    }
    const ctx = getRequestContext();
    const errorCategory = isDependency ? 'DEPENDENCY' : 'SYSTEM';
    try {
      const request = host.switchToHttp().getRequest<{ method?: string; route?: { path?: string }; path?: string }>();
      const method = request?.method ?? 'HTTP';
      // 路由模板优先（/api/v1/users/:id），未匹配路由时退化为实际路径；不落 query 参数
      const path = request?.route?.path ?? request?.path ?? '';
      this.errorLogWriter.write({
        errorCategory,
        exception,
        requestId,
        service: ctx?.service ?? 'unknown',
        source: `${method} ${path}`.trim(),
        deployCommit: process.env.DEPLOY_COMMIT ?? 'unknown',
        occurredAt: new Date(),
      });
    } catch (writeError) {
      const message = writeError instanceof Error ? writeError.message : String(writeError);
      this.logger.error(`集中错误日志写入回调失败: ${message}`);
    }
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

    // 7. 上传文件大小超限（MulterError LIMIT_FILE_SIZE → 413；当前 multer 上传仅 fin Excel 导入，
    //    与 PRD fin §4 约定的错误码一致；鸭子类型识别避免共享包依赖 multer 运行时）
    if (isMulterFileSizeError(exception)) {
      return { entry: financeErrors.IMPORT_FILE_TOO_LARGE };
    }

    // 8. 其它 HttpException：按 HTTP 状态映射为稳定类型（未知消息不得透传）
    if (exception instanceof HttpException) {
      return this.mapHttpException(exception);
    }

    // 9. 未知异常：SYSTEM 500 通用安全文案（集中系统日志在此追加）
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
/**
 * 识别 Multer 上传文件大小超限（MulterError LIMIT_FILE_SIZE）。
 *
 * 鸭子类型判断（共享包不依赖 multer 运行时）；LIMIT_FILE_SIZE 是 multer 稳定错误码，
 * 对应 PRD 约定的 413 上传超限。
 *
 * @param exception 待识别异常
 * @returns 是否文件大小超限
 */
function isMulterFileSizeError(exception: unknown): boolean {
  return (
    exception instanceof Error &&
    'code' in exception &&
    (exception as { code?: unknown }).code === 'LIMIT_FILE_SIZE'
  );
}

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
