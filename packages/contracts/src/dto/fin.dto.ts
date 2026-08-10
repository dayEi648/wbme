import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { isNonNegativeAmount } from '../money';
import { BATCH_LIMIT, IdempotentDto, IsValidatedBy, PaginationQueryDto } from './base.dto';

/** 项目文本长度上限（与页面 DTO 一致；Excel 导入校验共用，L22） */
export const PROJECT_NAME_MAX_LENGTH = 200;
export const PROJECT_SHORT_TEXT_MAX_LENGTH = 200;
export const PROJECT_PAYMENT_NODE_MAX_LENGTH = 500;
export const PROJECT_REMARK_MAX_LENGTH = 1000;
export const PROJECT_SUBCONTRACTORS_MAX_ITEMS = 50;

/** 自然日（YYYY-MM-DD；主 PRD §9.10 不经时区换算） */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 金额明细类型（F-2/F-3/F-4 三表同构） */
export type FinanceDetailType = 'invoice' | 'receipt' | 'subcontract-payment';

/** 金额明细单条（数组项：金额 + 可选日期/备注） */
export class FinanceAmountItemDto {
  @ApiProperty({ description: '金额（元，≥ 0，最多两位小数的十进制字符串）', example: '1234.50' })
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '金额必须是 ≥ 0 且最多两位小数的十进制字符串' })
  amount!: string;

  @ApiProperty({ description: '日期（YYYY-MM-DD）', required: false, example: '2026-08-01' })
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: '日期必须是 YYYY-MM-DD 格式' })
  occurredDate?: string;

  @ApiProperty({ description: '单笔备注', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/** 资料齐全度字典引用项（快照 [{id, name}]） */
export class DictRefItemDto {
  @ApiProperty({ description: '字典项 id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id!: number;

  @ApiProperty({ description: '字典项名称快照', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  name!: string;
}

/** 项目创建（fin PRD §3：名称+年度业务唯一键；非自动金额可留空，留空按 0 参与公式） */
export class ProjectCreateDto extends IdempotentDto {
  @ApiProperty({ description: '项目名称（保留原文展示；与年度共同构成业务唯一键）', maxLength: PROJECT_NAME_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_NAME_MAX_LENGTH)
  name!: string;

  @ApiProperty({ description: '年度（四位公历年 1000～9999）', example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(9999)
  year!: number;

  @ApiProperty({ description: '资料齐全度多选（按选择顺序，字典快照）', required: false, type: [DictRefItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DictRefItemDto)
  completenessDocs?: DictRefItemDto[];

  @ApiProperty({ description: '地区字典项 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  regionId?: number;

  @ApiProperty({ description: '项目进度字典项 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  progressId?: number;

  @ApiProperty({ description: '业务分类字典项 id（可空）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  bizCategoryId?: number;

  @ApiProperty({ description: '甲方', required: false, maxLength: PROJECT_SHORT_TEXT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PROJECT_SHORT_TEXT_MAX_LENGTH)
  partyA?: string;

  @ApiProperty({ description: '总包方', required: false, maxLength: PROJECT_SHORT_TEXT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PROJECT_SHORT_TEXT_MAX_LENGTH)
  generalContractor?: string;

  @ApiProperty({ description: '管理费（可能不为数字）', required: false, maxLength: PROJECT_SHORT_TEXT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PROJECT_SHORT_TEXT_MAX_LENGTH)
  managementFee?: string;

  @ApiProperty({ description: '分包方（手输数组）', required: false, type: [String], maxItems: PROJECT_SUBCONTRACTORS_MAX_ITEMS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PROJECT_SUBCONTRACTORS_MAX_ITEMS)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(PROJECT_SHORT_TEXT_MAX_LENGTH, { each: true })
  subcontractors?: string[];

  @ApiProperty({ description: '合同开始日期（YYYY-MM-DD）', required: false, example: '2026-01-01' })
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: '日期必须是 YYYY-MM-DD 格式' })
  contractStartDate?: string;

  @ApiProperty({ description: '合同完工日期（YYYY-MM-DD）', required: false, example: '2026-12-31' })
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: '日期必须是 YYYY-MM-DD 格式' })
  contractEndDate?: string;

  @ApiProperty({ description: '合同金额（元）', required: false, example: '100000.00' })
  @IsOptional()
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '金额必须是 ≥ 0 且最多两位小数的十进制字符串' })
  contractAmount?: string;

  @ApiProperty({ description: '主合同付款节点', required: false, maxLength: PROJECT_PAYMENT_NODE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PROJECT_PAYMENT_NODE_MAX_LENGTH)
  paymentNode?: string;

  @ApiProperty({ description: '暂定/审定金额（语义随项目进度切换）', required: false, example: '80000.00' })
  @IsOptional()
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '金额必须是 ≥ 0 且最多两位小数的十进制字符串' })
  tentativeAuditedAmount?: string;

  @ApiProperty({ description: '分包结算（元）', required: false, example: '30000.00' })
  @IsOptional()
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '金额必须是 ≥ 0 且最多两位小数的十进制字符串' })
  settlement?: string;

  @ApiProperty({ description: '零星费用（元）', required: false, example: '1000.00' })
  @IsOptional()
  @IsString()
  @IsValidatedBy(isNonNegativeAmount, { message: '金额必须是 ≥ 0 且最多两位小数的十进制字符串' })
  miscExpense?: string;

  @ApiProperty({ description: '项目级备注', required: false, maxLength: PROJECT_REMARK_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PROJECT_REMARK_MAX_LENGTH)
  remark?: string;
}

/** 项目编辑（fin PRD §3：名称与年度允许随时修改，保存时校验新业务键） */
export class ProjectUpdateDto extends ProjectCreateDto {}

/** 项目列表筛选（项目名称、甲方、年度、地区、业务分类和进度；fin PRD §3） */
export class ProjectQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '项目名称关键字（规范化匹配，支持模糊）', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiProperty({ description: '甲方关键字（模糊匹配）', required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  partyA?: string;

  @ApiProperty({ description: '年度精确筛选', required: false, minimum: 1000, maximum: 9999 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(9999)
  year?: number;

  @ApiProperty({ description: '地区字典项 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  regionId?: number;

  @ApiProperty({ description: '业务分类字典项 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  bizCategoryId?: number;

  @ApiProperty({ description: '项目进度字典项 id', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  progressId?: number;

  @ApiProperty({ description: '视图：normal=正常列表（默认），deleted=已删除视图（仅批量恢复）', required: false, enum: ['normal', 'deleted'] })
  @IsOptional()
  @IsIn(['normal', 'deleted'])
  view?: 'normal' | 'deleted';
}

/** 项目批量软删除（全有或全无；任一不可删除整批回滚并返回失败明细；主 PRD §2.6/§9.5 批量操作幂等） */
export class ProjectBatchDeleteDto extends IdempotentDto {
  @ApiProperty({ description: '项目 id 列表（1～100 个，不重复）', type: [Number] })
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];
}

/** 项目批量恢复（已删除视图勾选后批量恢复；保留原 ID/业务键/数据与操作历史；fin PRD §3；主 PRD §9.5 批量操作幂等） */
export class ProjectBatchRestoreDto extends IdempotentDto {
  @ApiProperty({ description: '项目 id 列表（1～100 个，不重复）', type: [Number] })
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];
}

/** 金额明细追加（每次只变更一条明细；fin PRD §4 即时保存约定） */
export class FinanceDetailCreateDto extends IdempotentDto {
  @ApiProperty({ description: '金额明细内容' })
  @ValidateNested()
  @Type(() => FinanceAmountItemDto)
  item!: FinanceAmountItemDto;
}

/** 金额明细修改（每次只变更一条明细） */
export class FinanceDetailUpdateDto extends IdempotentDto {
  @ApiProperty({ description: '金额明细内容（金额必填，日期/备注可清空）' })
  @ValidateNested()
  @Type(() => FinanceAmountItemDto)
  item!: FinanceAmountItemDto;
}

/** 利润分析单元格即时保存（fin PRD §4：单字段、白名单、幂等键；服务端拒绝多字段） */
export class ProfitCellSaveDto extends IdempotentDto {
  @ApiProperty({ description: '项目 id', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  projectId!: number;

  @ApiProperty({ description: '服务端白名单业务字段编码（一次一个）', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  field!: string;

  @ApiProperty({
    description: '字段新值（字符串/布尔/数组按字段类型解析；金额为十进制字符串；null=清空）',
  })
  value!: unknown;
}

/** 项目操作记录查询（fin PRD §5：只读列表；按时间倒序） */
export class ProjectOperationQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '按项目过滤', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  projectId?: number;
}

/** 财务字典创建（fin PRD §6：PROGRESS 必须带金额语义；地区为跨系统唯一维护点） */
export class FinDictItemCreateDto extends IdempotentDto {
  @ApiProperty({ description: '字典类型', enum: ['PROGRESS', 'COMPLETENESS', 'BIZ_CATEGORY', 'REGION'] })
  @IsIn(['PROGRESS', 'COMPLETENESS', 'BIZ_CATEGORY', 'REGION'])
  dictType!: 'PROGRESS' | 'COMPLETENESS' | 'BIZ_CATEGORY' | 'REGION';

  @ApiProperty({ description: '字典项名称（同类型下唯一；业务分类不得叫“未分类”）', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: '金额语义（仅 PROGRESS 必填；被引用后不可修改）', required: false, enum: ['TENTATIVE', 'AUDITED'] })
  @IsOptional()
  @IsIn(['TENTATIVE', 'AUDITED'])
  semantic?: 'TENTATIVE' | 'AUDITED';

  @ApiProperty({ description: '排序（小的在前）', required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort: number = 0;
}

/** 财务字典编辑（名称/语义/排序/启停） */
export class FinDictItemUpdateDto extends IdempotentDto {
  @ApiProperty({ description: '字典项名称', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: '金额语义（仅 PROGRESS；已被引用后不可修改）', required: false, enum: ['TENTATIVE', 'AUDITED'] })
  @IsOptional()
  @IsIn(['TENTATIVE', 'AUDITED'])
  semantic?: 'TENTATIVE' | 'AUDITED';

  @ApiProperty({ description: '排序（小的在前）' })
  @Type(() => Number)
  @IsInt()
  sort!: number;

  @ApiProperty({ description: '状态', enum: ['ACTIVE', 'DISABLED'] })
  @IsIn(['ACTIVE', 'DISABLED'])
  status!: 'ACTIVE' | 'DISABLED';
}

/** 财务字典查询 */
export class FinDictItemQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '字典类型过滤', required: false, enum: ['PROGRESS', 'COMPLETENESS', 'BIZ_CATEGORY', 'REGION'] })
  @IsOptional()
  @IsIn(['PROGRESS', 'COMPLETENESS', 'BIZ_CATEGORY', 'REGION'])
  dictType?: 'PROGRESS' | 'COMPLETENESS' | 'BIZ_CATEGORY' | 'REGION';

  @ApiProperty({ description: '状态过滤', required: false, enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

/** 财务字典批量硬删除（被项目引用则整批拒绝；fin PRD §6；幂等键 M10 同类补齐） */
export class FinDictItemBatchDeleteDto extends IdempotentDto {
  @ApiProperty({ description: '字典项 id 列表（1～100 个，不重复）', type: [Number] })
  @IsArray()
  @ArrayMaxSize(BATCH_LIMIT)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];
}

/** 导入确认的单行选择（Excel 行号 → 覆盖/跳过；fin PRD §4） */
export class ImportChoiceDto {
  @ApiProperty({ description: 'Excel 项目数据行号（1 起；与预览返回一致）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rowNumber!: number;

  @ApiProperty({ description: '覆盖或跳过', enum: ['OVERWRITE', 'SKIP'] })
  @IsIn(['OVERWRITE', 'SKIP'])
  decision!: 'OVERWRITE' | 'SKIP';

  @ApiProperty({ description: '覆盖目标的项目 id（预览待选择列表返回）', required: false, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  projectId?: number;

  @ApiProperty({ description: '覆盖目标的 dataRevision 前置条件（预览待选择列表返回）', required: false, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  dataRevision?: number;

  @ApiProperty({ description: '覆盖数据丢失警告确认（预览返回 dataLossWarning=true 的覆盖行必须为 true，L26）', required: false })
  @IsOptional()
  @IsBoolean()
  confirmDataLossWarning?: boolean;
}

/** 导入确认请求（选择映射 + 幂等键；服务端重新解析同一文件并校验） */
export class ImportConfirmDto extends IdempotentDto {
  @ApiProperty({ description: '选择映射（Excel 行号 → 覆盖/跳过）；数量与预览待选择行一致' })
  @IsArray()
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  })
  @Type(() => ImportChoiceDto)
  choices!: ImportChoiceDto[];
}

/** 导入请求幂等标识（确认接口的幂等键由客户端保持；预览无状态无需幂等） */
export class ImportRequestDto extends IdempotentDto {
  @ApiProperty({ description: '导入文件名（仅用于幂等语义提示，不参与解析）', required: false, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}
