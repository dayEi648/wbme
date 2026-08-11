import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { buildBorrowWhereSql } from './borrow.service';

/**
 * M20 复核修复回归：keyword（物品/借用人关键字）查询条件生成。
 * 该函数输出经 $queryRawUnsafe 直拼 SQL——关键字中的单引号必须转义（防注入），
 * 且 ILIKE 模糊匹配必须落在 consumable_name / user_name 两个字段。
 */
describe('buildBorrowWhereSql keyword（M20）', () => {
  it('keyword 生成物品名/借用人姓名 ILIKE 条件', () => {
    const sql = buildBorrowWhereSql({ keyword: '电脑' });
    expect(sql).toContain("consumable_name ILIKE '%电脑%'");
    expect(sql).toContain("user_name ILIKE '%电脑%'");
    expect(sql).toContain('WHERE');
  });

  it('关键字中的单引号被转义为 SQL 字面量（防注入）', () => {
    const sql = buildBorrowWhereSql({ keyword: "O'Brien" });
    expect(sql).toContain("'%O''Brien%'");
    expect(sql).not.toContain("'O'Brien'");
  });

  it('keyword 与既有条件以 AND 组合', () => {
    const sql = buildBorrowWhereSql({ recordType: 'AGENT', keyword: '张三' });
    expect(sql).toContain("record_type = 'AGENT'");
    expect(sql).toContain("AND (consumable_name ILIKE '%张三%' OR user_name ILIKE '%张三%')");
  });

  it('无关键字时不生成 keyword 条件', () => {
    const sql = buildBorrowWhereSql({ recordType: 'PERSONAL' });
    expect(sql).not.toContain('ILIKE');
    expect(sql).toContain("record_type = 'PERSONAL'");
  });
});

/**
 * 借还历史筛选回归（userId/recipientId 语义，borrow.dto.ts）：
 * userId = PERSONAL 借用人 + AGENT 发起人（审批头 proxy_id/applicant_id）；
 * recipientId = AGENT 受领人名单（agent_recipients）。
 */
describe('buildBorrowWhereSql userId / recipientId（借还历史筛选）', () => {
  it('userId 同时匹配 PERSONAL user_id 与 AGENT 审批头 proxy_id/applicant_id', () => {
    const sql = buildBorrowWhereSql({ userId: 42 });
    expect(sql).toContain('user_id = 42');
    expect(sql).toContain("record_type = 'AGENT'");
    expect(sql).toContain('FROM asset.approval_requests ar');
    expect(sql).toContain('ar.proxy_id = 42 OR ar.applicant_id = 42');
  });

  it('userId 与 recordType=PERSONAL 组合时 AGENT 分支不生效', () => {
    const sql = buildBorrowWhereSql({ userId: 42, recordType: 'PERSONAL' });
    expect(sql).toContain("record_type = 'PERSONAL'");
    // AGENT 分支被外层 record_type = 'PERSONAL' AND 排除（我的借还列表不受影响）
    expect(sql).toContain("record_type = 'AGENT' AND EXISTS");
  });

  it('recipientId 仅对 AGENT 记录匹配受领人名单', () => {
    const sql = buildBorrowWhereSql({ recipientId: 7 });
    expect(sql).toContain("record_type = 'AGENT' AND EXISTS");
    expect(sql).toContain('FROM asset.agent_recipients arp');
    // 关联键必须显式限定外层表（未限定的 request_id 会绑定到 arp.request_id 导致恒真）
    expect(sql).toContain('arp.request_id = borrow_records.request_id AND arp.user_id = 7');
  });

  it('departmentIds AGENT 分支关联键显式限定外层表（防恒真绑定）', () => {
    const sql = buildBorrowWhereSql({ departmentIds: new Set([1, 2]) });
    expect(sql).toContain('ar.id = borrow_records.request_id');
    expect(sql).toContain('arp.request_id = borrow_records.request_id');
  });
});
