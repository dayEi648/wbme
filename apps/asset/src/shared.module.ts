import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { DepartmentClosureService } from './shared/department-closure.service';
import { ScopeResolver } from './shared/scope-resolver';

/**
 * asset 全局共享模块：单一 PrismaService 实例与连接池（主 PRD §9.9）、
 * 部门闭包查询与历史数据范围解析（业务模块共用）。
 */
@Global()
@Module({
  providers: [PrismaService, DepartmentClosureService, ScopeResolver],
  exports: [PrismaService, DepartmentClosureService, ScopeResolver],
})
export class SharedModule {}
