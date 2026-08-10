import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BATCH_LIMIT, IdempotentDto, PaginationQueryDto } from './base.dto';

/**
 * hr 组织/部门/岗位/职称规则 DTO（hr PRD §5~§8）。
 * 配置类数据批量硬删除；职称规则软删除。
 */

/** 创建部门（hr PRD §6） */
export class DepartmentCreateDto extends IdempotentDto {
  @ApiProperty({
    description: '部门名称',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: '父部门 id（空 = 一级部门）',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  parentId?: number;

  @ApiProperty({
    description: '同级排序（越小越靠前）',
    required: false,
    minimum: 0,
    maximum: 9999,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

/** 更新部门（名称/排序/启停；移动用 move 接口） */
export class DepartmentUpdateDto extends IdempotentDto {
  @ApiProperty({
    description: '部门名称',
    required: false,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({
    description: '同级排序（越小越靠前）',
    required: false,
    minimum: 0,
    maximum: 9999,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;

  @ApiProperty({
    description: '启停状态',
    required: false,
    enum: ['ACTIVE', 'DISABLED'],
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

/** 移动部门节点（换父级；页面展示受影响子树并二次确认） */
export class DepartmentMoveDto extends IdempotentDto {
  @ApiProperty({
    description: '新父部门 id（空 = 移到一级）',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  parentId?: number;
}

/** 批量硬删除部门（hr PRD §6：有未删除下级时禁止；主 PRD §9.5 批量操作幂等） */
export class DepartmentDeleteDto extends IdempotentDto {
  @ApiProperty({
    description: `部门 id 列表（1-${BATCH_LIMIT} 个，互不重复）`,
    type: 'array',
    items: { type: 'number' },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  ids!: number[];
}

/** 批量硬删除岗位（主 PRD §9.5 批量操作幂等） */
export class PositionDeleteDto extends IdempotentDto {
  @ApiProperty({
    description: `岗位 id 列表（1-${BATCH_LIMIT} 个，互不重复）`,
    type: 'array',
    items: { type: 'number' },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  ids!: number[];
}

/** 创建岗位（hr PRD §7） */
export class PositionCreateDto extends IdempotentDto {
  @ApiProperty({
    description: '岗位名称',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: '岗位说明',
    required: false,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    description: '启停状态',
    required: false,
    enum: ['ACTIVE', 'DISABLED'],
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @ApiProperty({
    description: '同级排序（越小越靠前）',
    required: false,
    minimum: 0,
    maximum: 9999,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;

  @ApiProperty({
    description: '是否允许员工自助申请该岗位',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  allowSelfApply?: boolean;

  /** 适用部门（可空：创建时暂不指定） */
  @ApiProperty({
    description: '适用部门 id 列表（可空：创建时暂不指定）',
    required: false,
    type: 'array',
    items: { type: 'number' },
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  departmentIds?: number[];
}

/** 更新岗位（名称/说明/启停/排序/是否允许自助申请） */
export class PositionUpdateDto extends IdempotentDto {
  @ApiProperty({
    description: '岗位名称',
    required: false,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({
    description: '岗位说明',
    required: false,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    description: '启停状态',
    required: false,
    enum: ['ACTIVE', 'DISABLED'],
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @ApiProperty({
    description: '同级排序（越小越靠前）',
    required: false,
    minimum: 0,
    maximum: 9999,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;

  @ApiProperty({
    description: '是否允许员工自助申请该岗位',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  allowSelfApply?: boolean;
}

/** 更新岗位适用部门（修改前校验全部在岗员工兼容性，hr PRD §7） */
export class PositionDepartmentsUpdateDto extends IdempotentDto {
  @ApiProperty({
    description: `适用部门 id 列表（1-${BATCH_LIMIT} 个，互不重复）`,
    type: 'array',
    items: { type: 'number' },
  })
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  departmentIds!: number[];
}

/** 组织架构员工列表查询（hr PRD §5） */
export class OrgEmployeeQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '关键字（姓名/工号等模糊匹配）',
    required: false,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @ApiProperty({
    description: '按部门过滤',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @ApiProperty({
    description: '按岗位过滤',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionId?: number;

  /** ACTIVE=在职（默认） / DEACTIVATED=已注销（组织编排只看在职） */
  @ApiProperty({
    description: 'ACTIVE=在职（默认） / DEACTIVATED=已注销（组织编排只看在职）',
    required: false,
    enum: ['ACTIVE', 'DEACTIVATED'],
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'DEACTIVATED'])
  status?: 'ACTIVE' | 'DEACTIVATED';
}

/** 编排员工所属部门（多部门并列，hr PRD §5；岗位须适用全部新部门） */
export class EmployeeDepartmentsAssignDto extends IdempotentDto {
  @ApiProperty({
    description: `所属部门 id 列表（1-${BATCH_LIMIT} 个，互不重复）`,
    type: 'array',
    items: { type: 'number' },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  departmentIds!: number[];
}

/** 编排员工岗位（单岗位，hr PRD §5；须适用其全部当前部门） */
export class EmployeePositionAssignDto extends IdempotentDto {
  @ApiProperty({
    description: '岗位 id',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionId!: number;
}

/** 创建职称规则（hr PRD §8；条件可部分填写，全部非空条件同时成立） */
export class TitleRuleCreateDto extends IdempotentDto {
  @ApiProperty({
    description: '职称名称',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  titleName!: string;

  @ApiProperty({
    description: '条件：所属部门 id（空 = 不限定）',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @ApiProperty({
    description: '条件：岗位 id（空 = 不限定）',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionId?: number;

  @ApiProperty({
    description: '条件：站点角色（空 = 不限定）',
    required: false,
    enum: ['SUPER_ADMIN', 'EMPLOYEE'],
  })
  @IsOptional()
  @IsIn(['SUPER_ADMIN', 'EMPLOYEE'])
  roleCondition?: 'SUPER_ADMIN' | 'EMPLOYEE';

  @ApiProperty({
    description: '启停状态',
    required: false,
    enum: ['ACTIVE', 'DISABLED'],
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @ApiProperty({
    description: '同级排序（越小越靠前）',
    required: false,
    minimum: 0,
    maximum: 9999,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

/** 更新职称规则 */
export class TitleRuleUpdateDto extends IdempotentDto {
  @ApiProperty({
    description: '职称名称',
    required: false,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  titleName?: string;

  @ApiProperty({
    description: '条件：所属部门 id（空 = 不限定）',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @ApiProperty({
    description: '条件：岗位 id（空 = 不限定）',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionId?: number;

  @ApiProperty({
    description: '条件：站点角色（空 = 不限定）',
    required: false,
    enum: ['SUPER_ADMIN', 'EMPLOYEE'],
  })
  @IsOptional()
  @IsIn(['SUPER_ADMIN', 'EMPLOYEE'])
  roleCondition?: 'SUPER_ADMIN' | 'EMPLOYEE';

  @ApiProperty({
    description: '启停状态',
    required: false,
    enum: ['ACTIVE', 'DISABLED'],
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @ApiProperty({
    description: '同级排序（越小越靠前）',
    required: false,
    minimum: 0,
    maximum: 9999,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

/** 批量软删除职称规则（hr PRD §8：不提供硬删除；主 PRD §9.5 批量操作幂等） */
export class TitleRuleDeleteDto extends IdempotentDto {
  @ApiProperty({
    description: `职称规则 id 列表（1-${BATCH_LIMIT} 个，互不重复）`,
    type: 'array',
    items: { type: 'number' },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  ids!: number[];
}

/** 职称规则列表查询 */
export class TitleRuleQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '关键字（职称名称模糊匹配）',
    required: false,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @ApiProperty({
    description: '启停状态',
    required: false,
    enum: ['ACTIVE', 'DISABLED'],
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}
