import { expect, test } from '@playwright/test';

/** 加班个人页 E2E：验证月度汇总保留、冗余每日卡片移除及历史筛选文案。 */
const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('手机号').fill(PHONE);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
}

test.describe('加班个人视图', () => {
  test('保留月度汇总，移除每日明细；历史明细与导出共用完整筛选', async ({ page }) => {
    await login(page);
    await page.goto('/hr/overtime?tab=mine');
    await expect(page.getByText('本月加班汇总', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: '我的加班' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.wbme-desktop-toolbar')).toBeVisible();
    await expect(page.getByText('每日明细', { exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: '历史记录' }).click();
    await expect(page.getByRole('tab', { name: '历史记录' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.ant-empty-description:visible', { hasText: '暂无数据' })).toBeVisible();
    await page.locator('.wbme-desktop-toolbar').getByRole('button', { name: /^(filter\s+)?筛\s*选/ }).click();
    const filterDialog = page.getByRole('dialog', { name: '高级筛选' });
    await expect(filterDialog.getByText('高级筛选')).toBeVisible({ timeout: 15_000 });
    const filterFieldSelector = filterDialog.locator('.ant-select').first();
    await filterFieldSelector.click();
    const filterFieldSearch = filterFieldSelector.getByRole('combobox');
    for (const fieldName of ['部门', '加班日期', '开始时间', '结束时间', '审批人']) {
      await filterFieldSearch.fill(fieldName);
      await expect(page.getByRole('option', { name: fieldName, exact: true })).toHaveCount(1);
    }
    await filterDialog.getByRole('button', { name: /取\s*消/ }).click();
    await page.getByRole('button', { name: '导出' }).click();
    const exportMenu = page.locator('.ant-dropdown:not(.ant-dropdown-hidden)');
    await expect(exportMenu.getByText('导出加班记录', { exact: true })).toBeVisible();
    await expect(exportMenu.getByText('导出加班统计', { exact: true })).toBeVisible();
    await expect(exportMenu.getByText(/高级筛选后导出/)).toHaveCount(0);
    await page.keyboard.press('Escape');
    for (const [endpoint, filename] of [
      ['/api/hr/v1/overtime/records/export', '加班记录.xlsx'],
      ['/api/hr/v1/overtime/records/statistics/export', '加班统计.xlsx'],
    ] as const) {
      const response = await page.request.get(endpoint);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(response.headers()['content-disposition']).toContain(encodeURIComponent(filename));
      expect((await response.body()).subarray(0, 2).toString()).toBe('PK');
    }
  });
});
