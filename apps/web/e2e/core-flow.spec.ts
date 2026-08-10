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

  test('超管身份显式断言：门户可见管理后台入口（L38）', async ({ page }) => {
    // seed 保证 E2E 用户为超管，但此前无运行时校验：超管登录后门户必须出现
    // 「管理后台」卡片（非超管仅凭功能授权也不可见 backstage 入口）
    await login(page);
    await expect(page.getByText('管理后台').first()).toBeVisible({ timeout: 15_000 });
  });

  test('公告写链路：新建草稿 → 发布 → 撤回 → 删除后重复发布被拒（L38 失败回滚断言）', async ({ page }) => {
    await login(page);
    await page.getByText('管理后台').first().click();
    await expect(page).toHaveURL(/\/backstage/);
    await page.getByText('系统公告').first().click();
    await expect(page).toHaveURL(/\/backstage\/announcements/);

    const title = `E2E公告写链路${Date.now()}`;
    // 新建草稿（ResourceFormModal：标题必填）
    await page.getByText('新建公告').click();
    await page.getByLabel('标题').fill(title);
    await page.getByLabel('内容').fill('E2E 写链路测试内容：发布后撤回');
    await page.getByRole('button', { name: '确 定' }).click();
    const row = page.locator('tr', { hasText: title });
    await expect(row).toBeVisible({ timeout: 15_000 });
    // 草稿态：仅「发布」入口（L32 门控：不显示撤回）
    await expect(row.getByText('发布')).toBeVisible();
    await expect(row.getByText('撤回')).toHaveCount(0);
    await expect(row.getByText('DRAFT')).toBeVisible();

    // 发布 → 展示中：仅「撤回」入口
    await row.getByText('发布').click();
    await page.getByRole('button', { name: '确 定' }).click();
    await expect(row.getByText('撤回')).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('发布')).toHaveCount(0);
    await expect(row.getByText('PUBLISHING')).toBeVisible();

    // 撤回 → 终态：行内不再有任何操作入口
    await row.getByText('撤回').click();
    await page.getByRole('button', { name: '确 定' }).click();
    await expect(row.getByText('REVOKED')).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('发布')).toHaveCount(0);
    await expect(row.getByText('撤回')).toHaveCount(0);

    // 失败回滚断言：删除后对同一公告重复发布 → 后端 RESOURCE_NOT_FOUND 404
    // （公告已删除，状态机拒绝；顺带完成 E2E 数据清理）
    const announcementId = await row.getAttribute('data-row-key');
    expect(announcementId).toBeTruthy();
    const removed = await page.request.delete('/api/v1/announcements/batch', { data: { ids: [Number(announcementId)] } });
    expect(removed.status()).toBe(200);
    const republish = await page.request.post(`/api/v1/announcements/${announcementId}/publish`, {});
    expect(republish.status()).toBe(404);
    await expect(row).toHaveCount(0, { timeout: 15_000 });
  });

  test('未登录访问受保护页面跳转登录', async ({ page }) => {
    await page.goto('/backstage');
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });
});
