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
    await expect(page.getByText('WBME 企业管理平台', { exact: true })).toBeVisible();
    await expect(page.getByLabel('手机号', { exact: true })).toBeVisible();
    await expect(page.getByText('记住我', { exact: true })).toBeVisible();
    await expect(page.getByText('延长会话时限')).toHaveCount(0);
    await expect(page.locator('input[placeholder]')).toHaveCount(0);
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('注册、激活和重置密码页面不展示冗余占位说明', async ({ page }) => {
    await page.route('**/api/v1/auth/me', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 1, name: '测试用户', gender: 'MALE', phoneMasked: '138****0001', status: 'ACTIVE', isSuperAdmin: false },
          hasDingtalkBinding: false,
          functionCodes: [],
        }),
      }),
    );
    await page.route('**/api/v1/auth/registration/context', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ phone: '+8613800000001' }) }),
    );
    await page.goto('/register');
    await expect(page.getByLabel('姓名', { exact: true })).toBeVisible();
    await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
    await expect(page.getByLabel('确认密码', { exact: true })).toBeVisible();
    await expect(page.locator('input[placeholder]')).toHaveCount(0);

    await page.goto('/activate/complete');
    await expect(page.getByLabel('姓名', { exact: true })).toBeVisible();
    await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
    await expect(page.getByLabel('确认密码', { exact: true })).toBeVisible();
    await expect(page.locator('input[placeholder]')).toHaveCount(0);

    await page.goto('/reset-password/complete');
    await expect(page.getByLabel('新密码', { exact: true })).toBeVisible();
    await expect(page.getByLabel('确认新密码', { exact: true })).toBeVisible();
    await expect(page.locator('input[placeholder]')).toHaveCount(0);
  });

  test('错误密码登录失败并保持登录页', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('手机号', { exact: true }).fill(PHONE);
    await page.getByLabel('密码', { exact: true }).fill('wrong-password-1');
    await page.locator('button[type="submit"]').click();
    // 服务端统一错误提示（antd message），且不跳转门户
    await expect(page.getByText(/失败|错误|不存在|锁定/)).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('正确密码登录成功并进入门户', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('手机号', { exact: true }).fill(PHONE);
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
    await expect(page.getByText('资产').first()).toBeVisible();
  });
});
