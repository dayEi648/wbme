import { expect, test } from '@playwright/test';

/**
 * 核心业务链路 E2E（管理后台/资产台账读路径 + 公告写链路闭环，T10-4）。
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

test.describe('核心业务链路', () => {
  test('管理后台操作日志表格加载并可筛选', async ({ page }) => {
    await login(page);
    await page.getByText('管理后台').first().click();
    await expect(page).toHaveURL(/\/backstage/);
    // 分组导航：展开「运维监控」子菜单后进入操作日志
    await page.getByText('运维监控').click();
    await expect(page.getByText('操作日志').first()).toBeVisible({ timeout: 15_000 });
    await page.getByText('操作日志').first().click();
    await expect(page).toHaveURL(/\/backstage\/operation-logs/);
    await expect(page.getByRole('heading', { name: '操作日志' })).toBeVisible({ timeout: 15_000 });
    // DataTable 空列表只渲染 Empty（无表头）；新鲜 CI 库通常无操作日志。
    // 列表加载完成：空态「暂无数据」，或有历史数据时出现列文案「操作者」。
    await expect(page.getByText(/暂无数据|操作者/).first()).toBeVisible({ timeout: 15_000 });
    // 筛选契约（与用例名对齐）：抽屉快捷筛选含「操作者」字段，不依赖表格是否有行。
    // accessible name 形如「filter 筛选」或「filter 筛选（n）」；须锚定开头，避免命中「导出已筛选」。
    await page.locator('.wbme-desktop-toolbar').getByRole('button', { name: /^(filter\s+)?筛\s*选/ }).click();
    await expect(page.locator('.ant-drawer').getByText('操作者').first()).toBeVisible({ timeout: 15_000 });
  });

  test('资产台账页面加载（表格契约可用）', async ({ page }) => {
    await login(page);
    await page.getByText('资产').first().click();
    await expect(page).toHaveURL(/\/asset/);
    // 分组导航：展开「固定资产」子菜单后进入固定资产台账；页面标题渲染即路由可用
    await page.getByText('固定资产').click();
    await expect(page.getByText('固定资产台账').first()).toBeVisible({ timeout: 15_000 });
    await page.getByText('固定资产台账').first().click();
    await expect(page.getByRole('heading', { name: '固定资产台账' })).toBeVisible({ timeout: 15_000 });
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
    // 分组导航：展开「内容与配置」子菜单后进入系统公告
    await page.getByText('内容与配置').click();
    await page.getByText('系统公告').first().click();
    await expect(page).toHaveURL(/\/backstage\/announcements/);

    const title = `E2E公告写链路${Date.now()}`;
    // 新建草稿（ResourceFormModal：标题必填，提交按钮为「保存」；表单控件限定在弹窗内匹配，
    // 避免与列表表头「调整标题列宽」等 aria-label 歧义）
    // Ant Design Button + PlusOutlined：getByText 会同时命中 button 与内层 span（strict mode）
    await page.locator('.wbme-desktop-toolbar').getByRole('button', { name: /新建公告/ }).click();
    const dialog = page.getByRole('dialog', { name: '新建公告' });
    await dialog.getByLabel('标题').fill(title);
    await dialog.getByLabel('内容').fill('E2E 写链路测试内容：发布后撤回');
    await dialog.getByRole('button', { name: '保 存' }).click();
    const row = page.locator('tr', { hasText: title });
    await expect(row).toBeVisible({ timeout: 15_000 });
    // 草稿态：仅「发布」入口（L32 门控：不显示撤回）
    await expect(row.getByText('发 布')).toBeVisible();
    await expect(row.getByText('撤 回')).toHaveCount(0);
    await expect(row.getByText('DRAFT')).toBeVisible();

    // 发布 → 展示中：仅「撤回」入口
    await row.getByText('发 布').click();
    await page.getByRole('button', { name: '确 定' }).click();
    await expect(row.getByText('撤 回')).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('发 布')).toHaveCount(0);
    await expect(row.getByText('PUBLISHING')).toBeVisible();

    // 撤回 → 终态：行内不再有任何操作入口
    await row.getByText('撤 回').click();
    await page.getByRole('button', { name: '确 定' }).click();
    await expect(row.getByText('REVOKED')).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('发 布')).toHaveCount(0);
    await expect(row.getByText('撤 回')).toHaveCount(0);

    // 失败回滚断言：删除后对同一公告重复发布 → 后端 RESOURCE_NOT_FOUND 404
    // （公告已删除，状态机拒绝；顺带完成 E2E 数据清理）
    const announcementId = await row.getAttribute('data-row-key');
    expect(announcementId).toBeTruthy();
    // 直连 API 须携带 CSRF 双提交头（CsrfGuard 对带会话 Cookie 的状态变更请求强制校验）
    const csrf = await page.evaluate(() => document.cookie.match(/(?:^|; )wbme_csrf=([^;]*)/)?.[1] ?? '');
    expect(csrf).toBeTruthy();
    const csrfHeaders = { 'x-wbme-csrf-token': csrf };
    const removed = await page.request.delete('/api/v1/announcements/batch', { data: { ids: [Number(announcementId)] }, headers: csrfHeaders });
    expect(removed.status()).toBe(200);
    const republish = await page.request.post(`/api/v1/announcements/${announcementId}/publish`, { headers: csrfHeaders });
    expect(republish.status()).toBe(404);
    // 删除走 API 直连，UI 无自动刷新：reload 后断言行已消失（数据清理生效）
    await page.reload();
    await expect(page.locator('tr', { hasText: title })).toHaveCount(0, { timeout: 15_000 });
  });

  test('未登录访问受保护页面跳转登录', async ({ page }) => {
    await page.goto('/backstage');
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });
});
