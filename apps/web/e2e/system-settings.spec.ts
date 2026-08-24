import { expect, test } from '@playwright/test';

/** 系统设置页面：验证面向管理员的单位表达与系统开放状态控件。 */
const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('手机号').fill(PHONE);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
}

test.describe('系统设置体验', () => {
  test('会话以分钟编辑，通知时长可配置，系统状态使用开关', async ({ page }) => {
    await login(page);
    await page.goto('/backstage/settings');

    await expect(page.locator('#session .ant-card-head-title')).toHaveText('会话与安全', { timeout: 15_000 });
    const idleTimeout = page.getByLabel('普通会话空闲超时');
    await expect(idleTimeout).toHaveValue('1440');
    await expect(page.getByText('分钟').first()).toBeVisible();
    await expect(page.getByText('空闲超时不能长于绝对过期')).toHaveCount(0);

    await expect(page.locator('#notifications .ant-card-head-title')).toHaveText('界面通知');
    await expect(page.getByLabel('悬浮通知时长')).toHaveValue('5');
    await expect(page.locator('#notifications').getByText('秒')).toBeVisible();

    await expect(page.locator('#system-status > .ant-card-head .ant-card-head-title')).toHaveText('系统状态');
    await expect(page.getByRole('switch')).toHaveCount(3);
  });
});
