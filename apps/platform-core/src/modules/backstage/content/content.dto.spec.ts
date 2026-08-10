import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { BatchDeleteAnnouncementsDto } from './content.dto';

describe('公告批量删除 DTO 校验（重复 id 拒绝）', () => {
  it('重复 id 被拒绝（@ArrayUnique：避免 findMany 校验把存在目标误报为缺失）', async () => {
    const dto = new BatchDeleteAnnouncementsDto();
    dto.ids = [1, 1];
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'ids')).toBe(true);
  });

  it('合法 id 列表通过校验', async () => {
    const dto = new BatchDeleteAnnouncementsDto();
    dto.ids = [1, 2, 3];
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'ids')).toBe(false);
  });
});
