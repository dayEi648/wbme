import { describe, expect, it } from 'vitest';
import type { DataScope, SystemCode } from '../enums/common';
import { PERMISSION_CATALOG, flattenPermissionCatalog } from './catalog';

/** 合法数据范围档位（主 PRD §3.1） */
const ALL_DATA_SCOPES: readonly DataScope[] = ['SELF', 'DEPARTMENT', 'COMPANY'];

describe('功能权限目录权威定义（主 PRD §3.1、各系统 PRD §1）', () => {
  it('覆盖 BACKSTAGE/ASSET/HR/FIN 四个系统且编码唯一，BACKSTAGE 恒 OPEN', () => {
    const codes = PERMISSION_CATALOG.map((system) => system.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(['ASSET', 'BACKSTAGE', 'FIN', 'HR']);
    const backstage = PERMISSION_CATALOG.find((system) => system.code === 'BACKSTAGE');
    expect(backstage?.productStatus).toBe('OPEN');
  });

  it('目录规模与各系统 PRD §1 一致（4 系统 / 13 板块 / 36 功能）', () => {
    expect(PERMISSION_CATALOG).toHaveLength(4);
    const sectionCount = PERMISSION_CATALOG.reduce((count, system) => count + system.sections.length, 0);
    expect(sectionCount).toBe(13);
    // backstage §1 九项（批次 4 移除 system_structure_manage）、asset §1 十五项、hr §1 九项、fin §1 三项
    const functionCountBySystem: Record<SystemCode, number> = { BACKSTAGE: 9, ASSET: 15, HR: 9, FIN: 3 };
    for (const system of PERMISSION_CATALOG) {
      const count = system.sections.reduce((sum, section) => sum + section.functions.length, 0);
      expect(count, `${system.code} 功能数量与 PRD §1 不一致`).toBe(functionCountBySystem[system.code]);
    }
    expect(flattenPermissionCatalog()).toHaveLength(36);
  });

  it('稳定功能编码全平台唯一', () => {
    const codes = flattenPermissionCatalog().map((entry) => entry.definition.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('板块编码系统内唯一', () => {
    for (const system of PERMISSION_CATALOG) {
      const codes = system.sections.map((section) => section.code);
      expect(new Set(codes).size, `${system.code} 板块编码重复`).toBe(codes.length);
    }
  });

  it('可选数据范围为 SELF/DEPARTMENT/COMPANY 非空子集且无重复', () => {
    for (const entry of flattenPermissionCatalog()) {
      const options = entry.definition.dataScopeOptions;
      expect(options.length, `${entry.definition.code} 未声明可选数据范围`).toBeGreaterThan(0);
      expect(new Set(options).size, `${entry.definition.code} 数据范围档位重复`).toBe(options.length);
      for (const option of options) {
        expect(ALL_DATA_SCOPES, `${entry.definition.code} 非法数据范围 ${option}`).toContain(option);
      }
    }
  });

  it('功能与板块均有名称，功能均有业务说明（description 数据库初始值来源）', () => {
    for (const system of PERMISSION_CATALOG) {
      expect(system.name.trim().length).toBeGreaterThan(0);
      for (const section of system.sections) {
        expect(section.name.trim().length).toBeGreaterThan(0);
        for (const fn of section.functions) {
          expect(fn.name.trim().length, `${fn.code} 缺少名称`).toBeGreaterThan(0);
          expect(fn.description.trim().length, `${fn.code} 缺少业务说明`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('扁平化条目携带系统/板块归属与排序（排序 = 数组下标）', () => {
    const entries = flattenPermissionCatalog();
    const first = entries[0];
    expect(first).toMatchObject({ systemCode: 'BACKSTAGE', sectionCode: 'user', systemSort: 0, sectionSort: 0, functionSort: 0 });
    expect(first?.definition.code).toBe('user_manage');
    // 相邻条目的功能排序随板块内下标递增
    const second = entries[1];
    expect(second).toMatchObject({ systemCode: 'BACKSTAGE', sectionCode: 'content', sectionSort: 1, functionSort: 0 });
  });
});
