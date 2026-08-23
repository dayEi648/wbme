import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IdempotentDto } from '@wbme/contracts';

/** 单个系统的菜单分组数上限（任意层级合计；资源上限，主 PRD §9.5） */
export const MENU_GROUPS_LIMIT = 50;
/** 单个系统的菜单项数上限（资源上限，主 PRD §9.5） */
export const MENU_ITEMS_LIMIT = 200;

/**
 * 菜单分组展示配置行（任意层级，分组可自由嵌套）。
 * nodeKey 为稳定标识：代码默认名按层级用 `/` 连接（如 `用户与权限` 或 `用户与权限/组织架构`），
 * 菜单管理新建分组使用 `custom:` 前缀；
 * 改名只写 nameOverride，层级调整只写 parentKey，均不影响标识与菜单项关联。
 */
export class MenuGroupConfigRowDto {
  @ApiProperty({ description: '稳定标识：代码默认名按层级用 `/` 连接' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nodeKey!: string;

  @ApiProperty({ description: '父分组 nodeKey；null/缺省 = 顶层分组（分组可嵌套到任意深度，禁止引用自身或形成环）', required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  parentKey?: string | null;

  @ApiProperty({ description: '中文名覆盖；null/缺省 = 使用代码默认名', required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nameOverride?: string | null;

  @ApiProperty({ description: '同级范围内顺序（从 0 起）' })
  @IsInt()
  @Min(0)
  sortOrder!: number;
}

/**
 * 菜单项展示配置行。
 * itemKey = 前端 NavigationItem.key；path/permission/默认名仍由代码定义，本表只存展示层配置。
 */
export class MenuItemConfigRowDto {
  @ApiProperty({ description: '菜单项稳定标识（前端 NavigationItem.key）' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  itemKey!: string;

  @ApiProperty({ description: '直接父分组 nodeKey；null/缺省 = 顶层叶子（顶层叶子与分组共享同一顺序轴）', required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  parentKey?: string | null;

  @ApiProperty({ description: '中文名覆盖；null/缺省 = 使用代码默认名', required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nameOverride?: string | null;

  @ApiProperty({ description: '所属父节点范围内顺序（从 0 起）' })
  @IsInt()
  @Min(0)
  sortOrder!: number;
}

/** 保存某系统菜单展示配置（整树替换语义：载荷即该系统全量展示配置） */
export class SaveSystemMenuConfigDto extends IdempotentDto {
  @ApiProperty({ description: `分组行（最多 ${MENU_GROUPS_LIMIT} 行）`, type: [MenuGroupConfigRowDto] })
  @IsArray()
  @ArrayMaxSize(MENU_GROUPS_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => MenuGroupConfigRowDto)
  groups!: MenuGroupConfigRowDto[];

  @ApiProperty({ description: `菜单项行（最多 ${MENU_ITEMS_LIMIT} 行）`, type: [MenuItemConfigRowDto] })
  @IsArray()
  @ArrayMaxSize(MENU_ITEMS_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => MenuItemConfigRowDto)
  items!: MenuItemConfigRowDto[];
}
