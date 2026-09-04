import { expect, test } from '@playwright/test';

/**
 * 菜单管理 E2E（主 PRD §2.1）：系统设置「菜单管理」页签的改名 → 保存 → sidebar 生效 → 恢复默认闭环。
 * 前置与登录链路同 core-flow.spec.ts；用例结束恢复默认（清空 BACKSTAGE 菜单配置行），
 * afterEach 兜底再清一次，避免残留改名影响其它按默认菜单名导航的用例。
 */
const PHONE = process.env.E2E_USER_PHONE ?? '+8613800000001';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';
const RENAMED = 'E2E菜单验证';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('手机号').fill(PHONE);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
}

test.describe('菜单管理', () => {
  /** 与前端 http 客户端同口径的写请求头（Cookie 会话由 page.request 自动携带；CSRF 双提交 + 幂等键） */
  async function writeHeaders(page: import('@playwright/test').Page, key: string): Promise<Record<string, string>> {
    const csrf = (await page.context().cookies('http://127.0.0.1:45173')).find((cookie) => cookie.name === 'wbme_csrf')?.value ?? '';
    return { 'x-wbme-csrf-token': csrf, 'x-wbme-active': '1', 'idempotency-key': `${key}-${Date.now()}` };
  }

  test.afterEach(async ({ page }) => {
    // 兜底清理：无论断言在哪一步失败，都删除 BACKSTAGE 菜单配置行以恢复默认导航
    await page.request
      .delete('/api/v1/system-menu-configs/BACKSTAGE', { headers: await writeHeaders(page, 'e2e-menu-reset') })
      .catch(() => undefined);
  });

  test('菜单管理页签：改名保存后 sidebar 即时生效，恢复默认后还原', async ({ page }) => {
    await login(page);
    await page.getByText('管理后台').first().click();
    await expect(page).toHaveURL(/\/backstage/);
    // 分组导航：展开「内容与配置」进入系统设置
    await page.getByText('内容与配置').click();
    await page.getByText('系统设置').first().click();
    await expect(page).toHaveURL(/\/backstage\/settings/);

    // 「菜单管理」页签渲染默认导航树
    await page.getByRole('tab', { name: '菜单管理' }).click();
    const tree = page.locator('.ant-tree');
    await expect(tree.getByText('用户与权限')).toBeVisible({ timeout: 15_000 });
    await expect(tree.getByText('操作日志')).toBeVisible();

    // 改名：操作日志 → E2E菜单验证（行内编辑图标 → 弹窗输入 → 确定 → 保存）
    await page.getByRole('button', { name: '重命名 操作日志' }).click();
    await page.locator('.ant-modal input').fill(RENAMED);
    await page.locator('.ant-modal').getByRole('button', { name: '确 定' }).click();
    await expect(tree.getByText(RENAMED)).toBeVisible();
    await page.getByRole('button', { name: '保 存' }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: '保 存' }).click();
    await expect(page.getByText('菜单配置已保存，对本系统所有用户生效')).toBeVisible({ timeout: 15_000 });

    // sidebar 即时生效：运维监控分组下出现新名称
    await page.locator('.ant-layout-sider').getByText('运维监控').click();
    await expect(page.locator('.ant-layout-sider').getByText(RENAMED)).toBeVisible();

    // 恢复默认：清空配置行，sidebar 还原默认名
    await page.getByRole('button', { name: '恢复默认' }).click();
    await page.locator('.ant-modal').getByRole('button', { name: '恢复默认' }).click();
    await expect(page.getByText('已恢复默认菜单')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ant-layout-sider').getByText('操作日志')).toBeVisible();
    await expect(page.locator('.ant-layout-sider').getByText(RENAMED)).toHaveCount(0);
  });

  /** 侧边导航顶层条目文本序列（系统首页 + 顶层叶子/分组，按渲染顺序；取标题节点，展开的子菜单内容不计入） */
  async function topLevelMenuTexts(page: import('@playwright/test').Page): Promise<string[]> {
    return page.locator('.ant-layout-sider .ant-menu-root > li').evaluateAll((nodes) =>
      nodes.map((node) => (node.querySelector('.ant-menu-title-content')?.textContent ?? '').trim()),
    );
  }

  test('上移/下移按钮调序：保存后 sidebar 顶层顺序同步变化', async ({ page }) => {
    await login(page);
    await page.goto('/backstage/settings');
    await page.getByRole('tab', { name: '菜单管理' }).click();
    await expect(page.locator('.ant-tree').getByText('审批中心')).toBeVisible({ timeout: 15_000 });

    // 默认顶层：审批中心 → 用户与权限 → 内容与配置 → 运维监控；「下移 审批中心」与用户与权限交换
    await page.getByRole('button', { name: '下移 审批中心' }).click();
    await expect(page.getByText('有未保存的修改')).toBeVisible();
    await page.getByRole('button', { name: '保 存' }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: '保 存' }).click();
    await expect(page.getByText('菜单配置已保存，对本系统所有用户生效')).toBeVisible({ timeout: 15_000 });

    // 保存成功通知先于当前页面重新拉取并合并菜单配置；轮询最终渲染顺序，避免读取到旧导航的瞬时状态。
    await expect.poll(() => topLevelMenuTexts(page), { timeout: 15_000 }).toEqual([
      '系统首页',
      '用户与权限',
      '审批中心',
      '内容与配置',
      '运维监控',
    ]);
  });

  test('层级调整生效：分组任意嵌套（三级分组）后 sidebar 按新层级渲染', async ({ page }) => {
    await login(page);
    // 经 API 整树写入：内容与配置 降入 用户与权限、运维监控 再降入 内容与配置（三级分组）。
    // 拖拽手势由单测覆盖，此处验证 配置 → 渲染 链路（parentKey 直接父分组语义）
    const response = await page.request.put('/api/v1/system-menu-configs/BACKSTAGE', {
      headers: await writeHeaders(page, 'e2e-menu-nest'),
      data: {
        groups: [
          { nodeKey: '用户与权限', parentKey: null, nameOverride: null, sortOrder: 0 },
          { nodeKey: '内容与配置', parentKey: '用户与权限', nameOverride: null, sortOrder: 3 },
          { nodeKey: '运维监控', parentKey: '内容与配置', nameOverride: null, sortOrder: 2 },
        ],
        items: [
          { itemKey: 'approval', parentKey: null, nameOverride: null, sortOrder: 1 },
          { itemKey: 'users', parentKey: '用户与权限', nameOverride: null, sortOrder: 0 },
          { itemKey: 'permissions', parentKey: '用户与权限', nameOverride: null, sortOrder: 1 },
          { itemKey: 'groups', parentKey: '用户与权限', nameOverride: null, sortOrder: 2 },
          { itemKey: 'settings', parentKey: '内容与配置', nameOverride: null, sortOrder: 0 },
          { itemKey: 'announcements', parentKey: '内容与配置', nameOverride: null, sortOrder: 1 },
          { itemKey: 'operations', parentKey: '运维监控', nameOverride: null, sortOrder: 0 },
          { itemKey: 'system-logs', parentKey: '运维监控', nameOverride: null, sortOrder: 1 },
          { itemKey: 'backups', parentKey: '运维监控', nameOverride: null, sortOrder: 2 },
          { itemKey: 'health', parentKey: '运维监控', nameOverride: null, sortOrder: 3 },
          { itemKey: 'release-logs', parentKey: '运维监控', nameOverride: null, sortOrder: 4 },
        ],
      },
    });
    expect(response.ok()).toBe(true);

    await page.goto('/backstage');
    // 三级嵌套：用户与权限 → 内容与配置 → 运维监控 → 操作日志
    const sider = page.locator('.ant-layout-sider');
    await sider.getByText('用户与权限').click();
    await sider.getByText('内容与配置').click();
    await sider.getByText('运维监控').click();
    await expect(sider.getByText('操作日志')).toBeVisible();
    await expect(sider.getByText('系统公告')).toBeVisible();
    expect(await topLevelMenuTexts(page)).toEqual(['系统首页', '用户与权限', '审批中心']);
  });
});
