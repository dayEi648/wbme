import { expect, test } from '@playwright/test';

/**
 * 门户与个人中心 E2E（base PRD §5/§6）。
 * 前置：登录链路同 auth.spec.ts。
 */
const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('手机号').fill(PHONE);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
}

test.describe('门户与个人中心', () => {
  test('超管登录后门户展示全部系统入口与个人中心入口', async ({ page }) => {
    await login(page);
    // 超管视为拥有全部系统：资产 / 人事 / 财务 / 管理后台入口可见
    for (const entry of ['资产', '人事', '财务', '管理后台']) {
      await expect(page.getByText(entry).first()).toBeVisible();
    }
  });

  test('个人中心展示身份信息与我的操作日志', async ({ page }) => {
    await login(page);
    await page.getByText('个人中心').first().click();
    await expect(page).toHaveURL(/\/me/);
    // 个人资料 Tab（默认）：只读展示身份区域（E2E 用户姓名）
    await expect(page.getByText('E2E测试员')).toBeVisible({ timeout: 15_000 });
    // 我的日志 Tab：操作日志表格加载（登录行为本身已写操作日志）
    await page.getByRole('tab', { name: '我的日志' }).click();
    await expect(page.getByRole('columnheader', { name: '时间' })).toBeVisible({ timeout: 15_000 });
  });
});
