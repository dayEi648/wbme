import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ColumnSettingDto, FilterPresetDto, RenameFilterPresetDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { TablePrefsService } from './table-prefs.service';

/**
 * 个人表格偏好（账号作用域；仅需登录，无功能权限）。
 */
@ApiTags('表格偏好')
@Controller('me/table-prefs')
export class TablePrefsController {
  constructor(private readonly prefs: TablePrefsService) {}

  @Get(':pageKey/filter-presets')
  listFilterPresets(@CurrentUser() userId: number, @Param('pageKey') pageKey: string): Promise<unknown> {
    return this.prefs.listFilterPresets(userId, pageKey);
  }

  @Post(':pageKey/filter-presets')
  createFilterPreset(
    @CurrentUser() userId: number,
    @Param('pageKey') pageKey: string,
    @Body() dto: FilterPresetDto,
  ): Promise<unknown> {
    return this.prefs.createFilterPreset(userId, pageKey, dto);
  }

  @Put('filter-presets/:id')
  updateFilterPreset(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FilterPresetDto,
  ): Promise<unknown> {
    return this.prefs.updateFilterPreset(userId, id, dto);
  }

  @Put('filter-presets/:id/name')
  renameFilterPreset(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RenameFilterPresetDto,
  ): Promise<unknown> {
    return this.prefs.renameFilterPreset(userId, id, dto);
  }

  @Delete('filter-presets/:id')
  deleteFilterPreset(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.prefs.deleteFilterPreset(userId, id);
  }

  @Get(':pageKey/column-setting')
  getColumnSetting(@CurrentUser() userId: number, @Param('pageKey') pageKey: string): Promise<unknown> {
    return this.prefs.getColumnSetting(userId, pageKey);
  }

  @Put(':pageKey/column-setting')
  upsertColumnSetting(
    @CurrentUser() userId: number,
    @Param('pageKey') pageKey: string,
    @Body() dto: ColumnSettingDto,
  ): Promise<unknown> {
    return this.prefs.upsertColumnSetting(userId, pageKey, dto);
  }
}
