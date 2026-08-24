import { expect, test } from '@playwright/test';

const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('手机号').fill(PHONE);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
}

test.describe('全局悬浮通知', () => {
  test('操作成功后右侧卡片可打开居中详情', async ({ page }) => {
    await login(page);

    await page.getByRole('button', { name: /退出$/ }).click();
    await page.getByRole('tooltip').getByRole('button', { name: '退出登录' }).click();
    await expect(page).toHaveURL(/\/login/);

    const notification = page.locator('.wbme-floating-notification');
    await expect(notification).toBeVisible();
    await expect(notification).toContainText('操作成功');
    await expect(notification).toContainText('已退出登录');

    await notification.click();
    const detailsModal = page.locator('.ant-modal', { hasText: '操作成功' });
    await expect(detailsModal).toBeVisible();
    await expect(detailsModal).toContainText('已退出登录');
  });
});
