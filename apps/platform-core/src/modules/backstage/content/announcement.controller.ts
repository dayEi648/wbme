import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ANNOUNCEMENT_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import {
  BatchDeleteAnnouncementsDto,
  ListAnnouncementsDto,
  PublishAnnouncementDto,
  RevokeAnnouncementDto,
  UpsertAnnouncementDto,
} from './content.dto';
import { AnnouncementService } from './announcement.service';

/**
 * 系统公告管理（backstage PRD §8）。
 */
@ApiTags('系统公告')
@Controller('announcements')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(ANNOUNCEMENT_MANAGE_FUNCTION_CODE)
export class AnnouncementController {
  constructor(private readonly announcements: AnnouncementService) {}

  @Get()
  list(@Query() query: ListAnnouncementsDto): Promise<unknown> {
    return this.announcements.list(query);
  }

  @Post()
  create(@CurrentUser() operatorId: number, @Body() dto: UpsertAnnouncementDto): Promise<unknown> {
    return this.announcements.create(operatorId, dto);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() operatorId: number,
    @Body() dto: UpsertAnnouncementDto,
  ): Promise<unknown> {
    return this.announcements.update(operatorId, id, dto);
  }

  @Post(':id/publish')
  publish(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() operatorId: number,
    @Body() dto: PublishAnnouncementDto,
  ): Promise<unknown> {
    return this.announcements.publish(operatorId, id, dto.idempotencyKey);
  }

  @Post(':id/revoke')
  revoke(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() operatorId: number,
    @Body() dto: RevokeAnnouncementDto,
  ): Promise<unknown> {
    return this.announcements.revoke(operatorId, id, dto.idempotencyKey);
  }

  @Delete('batch')
  batchDelete(@CurrentUser() operatorId: number, @Body() dto: BatchDeleteAnnouncementsDto): Promise<unknown> {
    return this.announcements.batchDelete(operatorId, dto);
  }
}
