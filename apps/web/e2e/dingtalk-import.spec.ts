import { expect, test } from '@playwright/test';

const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';
const SNAPSHOT_ID = '5b1ce451-9790-4b07-ae0d-2d2ca7760cc4';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('手机号').fill(PHONE);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
}

/** 钉钉员工导入弹窗：完整手机号、服务端搜索、禁选和确认导入反馈。 */
test('用户管理可从钉钉选择员工导入', async ({ page }) => {
  let importedRequest: { snapshotId?: string; unionIds?: string[] } | null = null;
  await page.route('**/api/v1/users/dingtalk-import/candidates**', async (route) => {
    const keyword = new URL(route.request().url()).searchParams.get('keyword') ?? '';
    const candidates = [
      { unionId: 'ding-e2e-available', name: '张三', phone: '+8613912345678', importable: true },
      { unionId: 'ding-e2e-taken', name: '王五', phone: '+8613811112222', importable: false, disabledReason: '手机号已被平台账号使用' },
      { unionId: 'ding-e2e-search', name: '李四', phone: '+8613812345678', importable: true },
    ].filter((candidate) => !keyword || candidate.name.includes(keyword) || candidate.phone.includes(keyword));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        data: candidates,
        pagination: { page: 1, pageSize: 20, totalItems: candidates.length, totalPages: 1 },
      }),
    });
  });
  await page.route('**/api/v1/users/dingtalk-import', async (route) => {
    importedRequest = route.request().postDataJSON() as { snapshotId?: string; unionIds?: string[] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ userIds: [901], importedCount: 1 }) });
  });

  await login(page);
  await page.goto('/backstage/users');
  await expect(page.getByRole('button', { name: '从钉钉导入' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '从钉钉导入' }).click();

  const dialog = page.getByRole('dialog', { name: '从钉钉导入员工' });
  await expect(dialog.getByText('+8613912345678', { exact: true })).toBeVisible();
  const takenRow = dialog.locator('tr', { hasText: '王五' });
  await expect(takenRow.getByText('手机号已被平台账号使用', { exact: true })).toBeVisible();
  await expect(takenRow.locator('input[type="checkbox"]')).toBeDisabled();

  await dialog.getByLabel('搜索钉钉员工').fill('李四');
  await dialog.getByLabel('搜索钉钉员工').press('Enter');
  await expect(dialog.locator('tr', { hasText: '李四' })).toBeVisible();
  await expect(dialog.locator('tr', { hasText: '张三' })).toHaveCount(0);
  await dialog.locator('tr', { hasText: '李四' }).locator('input[type="checkbox"]').check();
  await dialog.getByRole('button', { name: '确认导入' }).click();

  const confirmDialog = page.getByRole('dialog', { name: '确认导入 1 名钉钉员工？' });
  await expect(confirmDialog.getByText('导入后会立即创建可用账号、写入默认密码并自动绑定钉钉账号，员工可直接扫码登录。')).toBeVisible();
  await confirmDialog.getByRole('button', { name: '确认导入' }).click();
  await expect(page.locator('.wbme-floating-notification')).toContainText('已成功导入 1 名员工');
  await expect(dialog).toHaveCount(0);
  expect(importedRequest).toEqual({ snapshotId: SNAPSHOT_ID, unionIds: ['ding-e2e-search'] });
});

test('系统设置以普通字段维护钉钉导入配置', async ({ page }) => {
  await page.route('**/api/v1/system-settings/dingtalk-import', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        appKeyConfigured: true,
        appSecretConfigured: true,
        corpIdConfigured: true,
        defaultPasswordConfigured: true,
        ready: true,
      }),
    });
  });
  await login(page);
  await page.goto('/backstage/settings');

  const card = page.locator('#dingtalk-import');
  await expect(card.getByText('钉钉员工导入', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(card.getByLabel('钉钉 AppKey')).toBeVisible();
  await expect(card.getByLabel('钉钉 AppSecret')).toBeVisible();
  await expect(card.getByLabel('钉钉组织 CorpId')).toBeVisible();
  await expect(card.getByLabel('钉钉导入默认密码')).toBeVisible();
  await expect(card.getByRole('button', { name: '保存钉钉导入配置' })).toBeEnabled();
  await expect(card.locator('.ant-alert')).toHaveCount(0);
});
