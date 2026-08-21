import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IdempotentDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { SaveSystemMenuConfigDto } from './menu-config.dto';
import { MenuConfigService, type SystemMenuConfig } from './menu-config.service';

/**
 * 系统导航菜单展示配置（主 PRD §2.1 菜单管理）。
 *
 * GET 仅需登录（所有登录用户渲染菜单都要读）；PUT/DELETE 在 service 内按系统
 * 动态映射既有配置功能码鉴权（BACKSTAGE→system_settings、ASSET→asset_config、
 * HR→hr_config、FIN→finance_config），与 FunctionPermissionGuard 同口径。
 */
@ApiTags('菜单管理')
@Controller('system-menu-configs')
export class MenuConfigController {
  constructor(private readonly menuConfig: MenuConfigService) {}

  /** 读取某系统菜单展示配置（空集合 = 未配置，前端使用代码默认菜单） */
  @Get(':systemCode')
  list(@Param('systemCode') systemCode: string): Promise<SystemMenuConfig> {
    return this.menuConfig.list(systemCode);
  }

  /** 整树替换保存某系统菜单展示配置 */
  @Put(':systemCode')
  save(
    @CurrentUser() operatorId: number,
    @Param('systemCode') systemCode: string,
    @Body() dto: SaveSystemMenuConfigDto,
  ): Promise<SystemMenuConfig> {
    return this.menuConfig.save(operatorId, systemCode, dto);
  }

  /** 恢复默认：清空该系统展示配置行 */
  @Delete(':systemCode')
  reset(
    @CurrentUser() operatorId: number,
    @Param('systemCode') systemCode: string,
    @Body() dto: IdempotentDto,
  ): Promise<SystemMenuConfig> {
    return this.menuConfig.reset(operatorId, systemCode, dto.idempotencyKey);
  }
}
