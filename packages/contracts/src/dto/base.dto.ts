import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsJSON, IsOptional, IsString, Max, MaxLength, Min, ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * DTO 基类与通用片段（主 PRD §9.5）。
 *
 * 全局校验管道统一启用 DTO 转换、白名单与非白名单字段拒绝；
 * 未声明字段直接拒绝，字符串长度、数值范围、批量数量必须有明确约束。
 *
 * 说明：共享契约包 DTO 不使用 Swagger CLI plugin（plugin 只处理各应用自身源码），
 * 全部属性显式标注 @ApiProperty 以保证 OpenAPI 文档与校验契约一致。
 */

/** 幂等写接口的公共字段（主 PRD §9.5：重要写接口支持幂等键） */
export class IdempotentDto {
  /** 客户端为一次用户意图生成的幂等键；网络重试时保持不变 */
  @ApiProperty({
    description: '客户端为一次用户意图生成的幂等键；网络重试时保持不变',
    required: false,
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

/** 批量操作公共约束：每次最多 100 个互不重复的目标标识（主 PRD §9.5 固定资源上限） */
export const BATCH_LIMIT = 100;

/** 全站分页参数：默认每页 20 条，可选 10/20/50/100 条，服务端最大接受 100（主 PRD §9.5） */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

/** 前端通用表格允许的受控操作符；字段名仍由各资源服务白名单解释。 */
const TABLE_FILTER_OPERATORS = new Set([
  'EQUALS',
  'NOT_EQUALS',
  'CONTAINS',
  'NOT_CONTAINS',
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL',
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL',
  'BEFORE',
  'AFTER',
  'BETWEEN',
]);

const TABLE_FILTER_MAX_GROUPS = 10;
const TABLE_FILTER_MAX_CONDITIONS = 100;
const TABLE_SORT_MAX_LEVELS = 10;

type JsonRecord = Record<string, unknown>;

/**
 * 为 DTO 的纯函数校验提供 class-validator 正确的装饰器桥接。
 *
 * @param predicate 待执行的同步谓词
 * @param validationOptions class-validator 错误信息等选项
 * @returns 属性验证装饰器
 */
export function IsValidatedBy<T>(
  predicate: (value: T) => boolean,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'wbmeValidatedBy',
      validator: { validate: (value: unknown) => predicate(value as T) },
    },
    validationOptions,
  );
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 验证单条结构化条件，禁止对象/SQL 片段替代字段、操作符和值。 */
function isFilterCondition(value: unknown): boolean {
  if (!isJsonRecord(value) || typeof value.field !== 'string' || value.field.length < 1 || value.field.length > 100) {
    return false;
  }
  if (typeof value.operator !== 'string' || !TABLE_FILTER_OPERATORS.has(value.operator) || typeof value.value !== 'string') {
    return false;
  }
  if (value.operator === 'BETWEEN') {
    return typeof value.valueEnd === 'string';
  }
  return value.valueEnd === undefined;
}

function isConditionGroup(value: unknown): boolean {
  if (!isJsonRecord(value) || value.logic !== 'AND' || !Array.isArray(value.conditions)) {
    return false;
  }
  return value.conditions.length >= 1 && value.conditions.length <= TABLE_FILTER_MAX_CONDITIONS && value.conditions.every(isFilterCondition);
}

/** 解析并验证简单 AND/OR 条件或“组内 AND、组间 OR”的结构化筛选载荷。 */
function isStructuredFiltersJson(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isJsonRecord(parsed)) return false;
    if (Array.isArray(parsed.conditions) && (parsed.logic === 'AND' || parsed.logic === 'OR') && parsed.groups === undefined) {
      return parsed.conditions.length >= 1 && parsed.conditions.length <= TABLE_FILTER_MAX_CONDITIONS && parsed.conditions.every(isFilterCondition);
    }
    return parsed.logic === 'OR' && Array.isArray(parsed.groups) && parsed.conditions === undefined
      && parsed.groups.length >= 1 && parsed.groups.length <= TABLE_FILTER_MAX_GROUPS && parsed.groups.every(isConditionGroup);
  } catch {
    return false;
  }
}

/** 多级排序只接受受控字段名与 ASC/DESC；具体字段白名单由资源服务决定。 */
function isStructuredSortsJson(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      && parsed.length >= 1
      && parsed.length <= TABLE_SORT_MAX_LEVELS
      && parsed.every((item) => isJsonRecord(item)
        && typeof item.field === 'string'
        && item.field.length >= 1
        && item.field.length <= 100
        && (item.direction === 'ASC' || item.direction === 'DESC'));
  } catch {
    return false;
  }
}

export class PaginationQueryDto {
  @ApiProperty({
    description: '页码（从 1 开始）',
    required: false,
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiProperty({
    description: '每页条数（服务端接受 10/20/50/100）',
    required: false,
    default: 20,
    minimum: 10,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(100)
  pageSize: number = 20;

  /**
   * 结构化筛选条件 JSON（前端通用表格契约）。
   *
   * 业务 DTO 仍可保留其经过索引与权限审计的具名筛选字段；服务端按页面白名单解释条件，
   * 不接受任意 Prisma 字段或 SQL 片段。
   */
  @ApiProperty({
    description: '结构化筛选条件 JSON：简单条件为 { logic, conditions: [{ field, operator, value, valueEnd? }] }；条件组为 { logic: "OR", groups: [{ logic: "AND", conditions: [...] }] }',
    required: false,
    maxLength: 16000,
  })
  @IsOptional()
  @IsString()
  @IsJSON()
  @IsValidatedBy((value) => typeof value === 'string' && isStructuredFiltersJson(value), { message: '筛选条件结构或操作符不合法' })
  @MaxLength(16000)
  filters?: string;

  /** 多级排序 JSON（前端通用表格契约；字段按各资源白名单解释）。 */
  @ApiProperty({
    description: '多级排序 JSON：[{ field, direction: "ASC"|"DESC" }]',
    required: false,
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @IsJSON()
  @IsValidatedBy((value) => typeof value === 'string' && isStructuredSortsJson(value), { message: '排序条件结构不合法' })
  @MaxLength(4000)
  sorts?: string;
}
