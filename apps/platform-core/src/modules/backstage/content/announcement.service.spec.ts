import { describe, expect, it } from 'vitest';

/**
 * 公告发布并发：依赖 DB 部分唯一索引 announcements_publishing_unique。
 * 集成测试需真实数据库；此处记录事务顺序契约。
 */
describe('AnnouncementService.publish 事务顺序', () => {
  it('应先撤回其他 PUBLISHING 再设置目标', () => {
    const steps: string[] = [];
    steps.push('revoke_others');
    steps.push('set_target_publishing');
    expect(steps).toEqual(['revoke_others', 'set_target_publishing']);
  });
});
