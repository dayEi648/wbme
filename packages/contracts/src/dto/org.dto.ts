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
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  parentId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

/** 更新部门（名称/排序/启停；移动用 move 接口） */
export class DepartmentUpdateDto extends IdempotentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

/** 移动部门节点（换父级；页面展示受影响子树并二次确认） */
export class DepartmentMoveDto extends IdempotentDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  parentId?: number;
}

/** 批量硬删除部门（hr PRD §6：有未删除下级时禁止） */
export class DepartmentDeleteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  ids!: number[];
}

/** 批量硬删除岗位 */
export class PositionDeleteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  ids!: number[];
}

/** 创建岗位（hr PRD §7） */
export class PositionCreateDto extends IdempotentDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;

  @IsOptional()
  @IsBoolean()
  allowSelfApply?: boolean;

  /** 适用部门（可空：创建时暂不指定） */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  departmentIds?: number[];
}

/** 更新岗位（名称/说明/启停/排序/是否允许自助申请） */
export class PositionUpdateDto extends IdempotentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;

  @IsOptional()
  @IsBoolean()
  allowSelfApply?: boolean;
}

/** 更新岗位适用部门（修改前校验全部在岗员工兼容性，hr PRD §7） */
export class PositionDepartmentsUpdateDto extends IdempotentDto {
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  departmentIds!: number[];
}

/** 组织架构员工列表查询（hr PRD §5） */
export class OrgEmployeeQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionId?: number;

  /** ACTIVE=在职（默认） / DEACTIVATED=已注销（组织编排只看在职） */
  @IsOptional()
  @IsIn(['ACTIVE', 'DEACTIVATED'])
  status?: 'ACTIVE' | 'DEACTIVATED';
}

/** 编排员工所属部门（多部门并列，hr PRD §5；岗位须适用全部新部门） */
export class EmployeeDepartmentsAssignDto extends IdempotentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  departmentIds!: number[];
}

/** 编排员工岗位（单岗位，hr PRD §5；须适用其全部当前部门） */
export class EmployeePositionAssignDto extends IdempotentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionId!: number;
}

/** 创建职称规则（hr PRD §8；条件可部分填写，全部非空条件同时成立） */
export class TitleRuleCreateDto extends IdempotentDto {
  @IsString()
  @MaxLength(100)
  titleName!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionId?: number;

  @IsOptional()
  @IsIn(['SUPER_ADMIN', 'EMPLOYEE'])
  roleCondition?: 'SUPER_ADMIN' | 'EMPLOYEE';

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

/** 更新职称规则 */
export class TitleRuleUpdateDto extends IdempotentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  titleName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionId?: number;

  @IsOptional()
  @IsIn(['SUPER_ADMIN', 'EMPLOYEE'])
  roleCondition?: 'SUPER_ADMIN' | 'EMPLOYEE';

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

/** 批量软删除职称规则（hr PRD §8：不提供硬删除） */
export class TitleRuleDeleteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  ids!: number[];
}

/** 职称规则列表查询 */
export class TitleRuleQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}
