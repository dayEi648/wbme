import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { reconcilePermissionCatalog } from './permission-catalog.reconcile';

/**
 * 权限目录启动对账服务（实现规划 T3-1、主 PRD §3.1）。
 *
 * platform-core 启动时（监听端口前的 NestJS 生命周期钩子）执行一次幂等对账：
 * 代码目录（@wbme/contracts PERMISSION_CATALOG）与数据库注册表对齐，
 * 目录语义变化时同事务递增全局权限目录版本，旧授权缓存随之失效（base PRD §3）。
 * 对账失败（数据库不可用、约束冲突等）直接抛出使启动失败，避免以过期目录对外提供服务。
 */
@Injectable()
export class PermissionCatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionCatalogService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 启动对账：无变化时不产生任何写入、不递增版本（幂等） */
  async onApplicationBootstrap(): Promise<void> {
    const report = await reconcilePermissionCatalog(this.prisma.client);
    const writeCount =
      report.systemsCreated +
      report.systemsUpdated +
      report.sectionsCreated +
      report.sectionsUpdated +
      report.sectionsRemoved +
      report.functionsCreated +
      report.functionsUpdated +
      report.functionsRemoved;
    if (report.semanticChanged) {
      this.logger.log(
        `权限目录对账：功能 +${report.functionsCreated}/-${report.functionsRemoved}/~${report.functionsUpdated}，` +
          `板块 +${report.sectionsCreated}/-${report.sectionsRemoved}/~${report.sectionsUpdated}，` +
          `系统 +${report.systemsCreated}/~${report.systemsUpdated}，目录版本=${report.catalogVersion}`,
      );
      return;
    }
    if (writeCount > 0) {
      // 纯展示层修正（名称/排序/空壳板块清理等）不改变授权语义，不递增目录版本（主 PRD §3.1）
      this.logger.log(
        `权限目录对账：仅展示层修正（系统 +${report.systemsCreated}/~${report.systemsUpdated}，` +
          `板块 +${report.sectionsCreated}/-${report.sectionsRemoved}/~${report.sectionsUpdated}，` +
          `功能 ~${report.functionsUpdated}），目录版本不变=${report.catalogVersion}`,
      );
      return;
    }
    this.logger.log(`权限目录对账：无变化（目录版本=${report.catalogVersion}）`);
  }
}
