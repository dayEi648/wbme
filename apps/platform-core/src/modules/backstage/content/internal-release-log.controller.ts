import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AllowedCallers, InternalAuthGuard, Public } from '@wbme/server';
import { AppendReleaseLogDto } from './content.dto';
import { ReleaseLogService } from './release-log.service';

/**
 * 更新日志内部接口（backstage PRD §9 / 主 PRD §9.9）。
 *
 * 调用方 = 发布脚本（宿主经 `docker compose exec` 在容器内访问，不暴露公网；
 * 主 PRD §9.14：/internal/v1 只存在于 Compose 私有网络）。releaseId 幂等：
 * 相同发布标识或目标 commit 重试不重复生成（重复发布不重复记录）。
 */
@Public()
@UseGuards(InternalAuthGuard)
@Controller('internal/v1/release-logs')
export class InternalReleaseLogController {
  constructor(private readonly releaseLogs: ReleaseLogService) {}

  /** 发布成功并通过全部就绪检查后追加一条平台级更新日志 */
  @Post('append')
  @AllowedCallers('release-script')
  async append(@Body() dto: AppendReleaseLogDto): Promise<{ id: number; releaseId: string; created: boolean }> {
    return this.releaseLogs.appendReleaseLog(dto);
  }
}
