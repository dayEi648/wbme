import { AppstoreOutlined, LogoutOutlined, MenuOutlined, UserOutlined } from '@ant-design/icons';
import { Avatar, Breadcrumb, Button, Drawer, Grid, Layout, Menu, Space, Typography, theme, type MenuProps } from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useFeedback } from '../request/feedback';
import { useSession } from '../request/session';
import { HistoryNavButtons } from './HistoryNavButtons';
import { ConfirmAction } from './ConfirmAction';

const { Header, Sider, Content } = Layout;

/** 平台品牌名：作为各业务系统侧边栏顶部 LOGO 的标题展示。 */
const PLATFORM_BRAND_NAME = 'WBME';
/** 平台统一门户路径：LOGO 点击后回到系统入口首页。 */
const PORTAL_PATH = '/portal';

export interface NavigationItem {
  key: string;
  label: string;
  path: string;
  /** 一级业务分组（如"消耗品"）；未声明时作为顶层叶子项。顶层叶子与分组块按数组顺序混排渲染。 */
  group?: string;
  /** 二级业务分组（如"消耗品申领"），仅在声明 group 时生效。 */
  subGroup?: string;
  /**
   * 祖先分组显示名路径（菜单管理归并产物；优先于 group/subGroup）。
   * 长度任意：分组可自由嵌套；同名同级合并、跨分支独立。
   */
  groupPath?: string[];
  /** 单个功能或"具备任一即可"的功能集合；仅用于体验层菜单显隐。 */
  permission?: string | string[];
}

interface AppShellProps {
  systemName: string;
  homePath: string;
  items: NavigationItem[];
  children: ReactNode;
}

type MenuNode =
  | { key: string; label: string; icon?: ReactNode }
  | { key: string; label: string; icon?: ReactNode; children: MenuNode[] };

/**
 * 菜单项的祖先分组显示名路径：菜单管理归并产物 groupPath 优先，
 * 代码默认声明回退 group/subGroup 两段式（二者等价于 path = [group, subGroup] 过滤空值）。
 */
const groupPathOf = (item: NavigationItem): string[] =>
  item.groupPath ?? [item.group, item.subGroup].filter((name): name is string => Boolean(name));

/** 分组节点的菜单 key = 显示名路径（同名同级合并、跨分支独立） */
const groupMenuKey = (path: string[]): string => `group:${path.join('/')}`;

/**
 * 业务系统与管理后台共用的响应式页面壳。
 *
 * 菜单按祖先分组路径递归渲染：分组可自由嵌套（代码默认最多两级，菜单管理可突破）；
 * 未分组的项作为顶层叶子。侧边栏顶部为可点击的品牌 LOGO（返回统一门户）；
 * Header 左侧为全站统一的回退/前进/刷新，Header 内展示当前页面位置面包屑（系统名 → 各级分组 → 页面）。
 * 菜单只渲染当前会话被授予的功能；路由及接口的最终访问控制仍由服务端负责。
 */
export function AppShell({ systemName, homePath, items, children }: AppShellProps) {
  const { token } = theme.useToken();
  const { user, can, logout } = useSession();
  const feedback = useFeedback();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  /** 软刷新：递增 key 重挂载内容区，重新拉数且不丢 SPA 状态。 */
  const [refreshKey, setRefreshKey] = useState(0);

  const visibleItems = useMemo(
    () => items.filter((item) => !item.permission || (Array.isArray(item.permission) ? item.permission.some((code) => can(code)) : can(item.permission))),
    [can, items],
  );
  const current = useMemo(() => {
    const exact = visibleItems.find((item) => location.pathname === item.path);
    if (exact) {
      return exact;
    }
    const nested = [...visibleItems].sort((left, right) => right.path.length - left.path.length).find((item) => location.pathname.startsWith(`${item.path}/`));
    return nested;
  }, [location.pathname, visibleItems]);

  /** 菜单结构：首页 + 按数组序混排的顶层叶子与分组子菜单（分组按 groupPath 任意嵌套，空分组不渲染）。 */
  const menuItems = useMemo<MenuProps['items']>(() => {
    const homeItem: MenuNode = { key: homePath, label: '系统首页', icon: <AppstoreOutlined /> };
    const topLevel: MenuNode[] = [];
    // 已创建的分组节点索引（key = 显示名路径）；同名同级合并、跨分支独立
    const groupIndex = new Map<string, MenuNode>();
    for (const item of visibleItems) {
      const leaf: MenuNode = { key: item.path, label: item.label };
      const path = groupPathOf(item);
      if (path.length === 0) {
        topLevel.push(leaf);
        continue;
      }
      let siblings = topLevel;
      for (let depth = 0; depth < path.length; depth += 1) {
        const key = groupMenuKey(path.slice(0, depth + 1));
        let group = groupIndex.get(key);
        if (!group) {
          group = { key, label: path[depth] ?? '', children: [] };
          groupIndex.set(key, group);
          siblings.push(group);
        }
        siblings = 'children' in group ? group.children : [];
      }
      siblings.push(leaf);
    }
    return [homeItem, ...topLevel];
  }, [homePath, visibleItems]);

  const selectedKeys = useMemo(() => [current?.path ?? homePath], [current, homePath]);
  /** 当前页祖先分组 key（直链/刷新时自动展开）；用户手动折叠由受控 openKeys 保留。 */
  const currentAncestorKeys = useMemo(() => {
    if (!current) {
      return [];
    }
    const path = groupPathOf(current);
    return path.map((_, depth) => groupMenuKey(path.slice(0, depth + 1)));
  }, [current]);
  const [openKeys, setOpenKeys] = useState<string[]>(currentAncestorKeys);
  useEffect(() => {
    setOpenKeys((previous) => [...new Set([...previous, ...currentAncestorKeys])]);
  }, [currentAncestorKeys]);

  const onMenuSelect: MenuProps['onClick'] = ({ key }) => {
    setMobileNavOpen(false);
    navigate(key);
  };

  const handleLogoClick = () => {
    setMobileNavOpen(false);
    navigate(PORTAL_PATH);
  };

  const handleLogout = async () => {
    await logout();
    feedback.success('已退出登录');
  };

  const breadcrumbItems = [
    { title: systemName },
    ...(current ? groupPathOf(current).map((name) => ({ title: name })) : []),
    ...(current ? [{ title: current.label }] : []),
  ];

  const navigation = (
    <>
      <div style={{ padding: '16px 20px' }}>
        <button
          type="button"
          onClick={handleLogoClick}
          aria-label="返回门户首页"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 16,
            fontWeight: 600,
            color: token.colorText,
          }}
        >
          <AppstoreOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
          {PLATFORM_BRAND_NAME}
        </button>
      </div>
      <Menu
        mode="inline"
        selectedKeys={selectedKeys}
        openKeys={openKeys}
        onOpenChange={(keys) => setOpenKeys(keys as string[])}
        items={menuItems}
        onClick={onMenuSelect}
      />
    </>
  );

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      {screens.lg ? <Sider width={224} theme="light">{navigation}</Sider> : null}
      <Layout>
        <Header style={{ background: token.colorBgContainer, display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingInline: 16 }}>
          <Space>
            {!screens.lg ? <Button type="text" icon={<MenuOutlined />} aria-label="打开导航" onClick={() => setMobileNavOpen(true)} /> : null}
            <HistoryNavButtons onRefresh={() => setRefreshKey((value) => value + 1)} />
            {current ? <Breadcrumb items={breadcrumbItems} /> : <Typography.Text strong>{systemName}</Typography.Text>}
          </Space>
          <Space>
            <Button type="text" icon={<UserOutlined />} onClick={() => navigate('/me')}>
              {user?.name ?? '个人中心'}
            </Button>
            <ConfirmAction title="确认退出登录？" description="退出后需要重新登录才能访问系统。" okText="退出登录" onConfirm={() => void handleLogout()}>
              <Button type="text" icon={<LogoutOutlined />} aria-label="退出登录" />
            </ConfirmAction>
          </Space>
        </Header>
        <Content style={{ padding: screens.lg ? 16 : 12, maxWidth: 1680, width: '100%', margin: '0 auto' }}>
          <div key={refreshKey}>{children}</div>
        </Content>
      </Layout>
      <Drawer title={systemName} open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} placement="left" width="min(92vw, 280px)" styles={{ body: { padding: 0 } }}>
        <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Avatar icon={<UserOutlined />} />
          <Typography.Text>{user?.name}</Typography.Text>
        </div>
        {navigation}
      </Drawer>
    </Layout>
  );
}
