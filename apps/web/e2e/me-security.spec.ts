import { expect, test } from '@playwright/test';

/**
 * 个人中心-账户安全 E2E（base PRD §2/§6）。
 * 前置：scripts/e2e-seed.mjs 已创建 ACTIVE 测试用户（默认 +8613800000001 / E2ePassw0rd!，未绑定钉钉）。
 */
const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

test.describe('账户安全', () => {
  test('未绑定钉钉的账号在账户安全页可见自助绑定入口', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('手机号').fill(PHONE);
    await page.getByLabel('密码').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });

    await page.goto('/me?tab=security');
    await expect(page.getByRole('button', { name: '绑定钉钉' })).toBeVisible();
    await expect(page.getByRole('button', { name: '修改密码' })).toBeVisible();
  });
});
