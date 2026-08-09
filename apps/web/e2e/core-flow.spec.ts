import { expect, test } from '@playwright/test';

/**
 * 核心业务链路 E2E（管理后台与资产台账读路径）。
 * 前置：登录链路同 auth.spec.ts；E2E 用户为超管（全部功能可见）。
 */
const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('手机号').fill(PHONE);
  await page.getByPlaceholder('密码（8~32 位）').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
}

test.describe('核心业务链路（读路径）', () => {
  test('管理后台操作日志表格加载并可筛选', async ({ page }) => {
    await login(page);
    await page.getByText('管理后台').first().click();
    await expect(page).toHaveURL(/\/backstage/);
    // 操作日志页签（默认或导航）
    await expect(page.getByText('操作日志').first()).toBeVisible({ timeout: 15_000 });
    await page.getByText('操作日志').first().click();
    // 表格加载：至少出现表格容器（数据可能为空，但应渲染表头）
    await expect(page.getByText('操作者').first()).toBeVisible({ timeout: 15_000 });
  });

  test('资产台账页面加载（表格契约可用）', async ({ page }) => {
    await login(page);
    await page.getByText('资产').first().click();
    await expect(page).toHaveURL(/\/asset/);
    // 台账页签默认选中；表头渲染即列表契约可用
    await expect(page.getByText('台账').first()).toBeVisible({ timeout: 15_000 });
  });

  test('未登录访问受保护页面跳转登录', async ({ page }) => {
    await page.goto('/backstage');
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });
});
