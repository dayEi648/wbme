import { expect, test } from '@playwright/test';

/**
 * 认证链路 E2E（base PRD §2/§3）。
 * 前置：scripts/e2e-seed.mjs 已创建 ACTIVE 测试用户（默认 +8613800000001 / E2ePassw0rd!）。
 */
const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

test.describe('认证链路', () => {
  test('登录页可访问并渲染登录表单', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByPlaceholder('手机号')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('错误密码登录失败并保持登录页', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('手机号').fill(PHONE);
    await page.getByPlaceholder('密码（8~32 位）').fill('wrong-password-1');
    await page.locator('button[type="submit"]').click();
    // 服务端统一错误提示（antd message），且不跳转门户
    await expect(page.getByText(/失败|错误|不存在|锁定/)).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('正确密码登录成功并进入门户', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('手机号').fill(PHONE);
    await page.getByPlaceholder('密码（8~32 位）').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
    await expect(page.getByText('资产').first()).toBeVisible();
  });
});
