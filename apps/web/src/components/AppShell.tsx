import { AppstoreOutlined, LogoutOutlined, MenuOutlined, SearchOutlined, UserOutlined } from '@ant-design/icons';
import { Avatar, Breadcrumb, Button, Drawer, Grid, Input, Layout, Menu, Space, Typography, theme, type MenuProps } from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useFeedback } from '../request/feedback';
import { useSession } from '../request/session';
import { HistoryNavButtons } from './HistoryNavButtons';

const { Header, Sider, Content } = Layout;

export interface NavigationItem {
  key: string;
  label: string;
  path: string;
  /** 一级业务分组（如"消耗品"）；未声明时作为顶层叶子项（紧跟"系统首页"之后）。 */
  group?: string;
  /** 二级业务分组（如"消耗品申领"），仅在声明 group 时生效。 */
  subGroup?: string;
  /** 单个功能或"具备任一即可"的功能集合；仅用于体验层菜单显隐。 */
  permission?: string | string[];
}

interface AppShellProps {
  systemName: string;
  homePath: string;
  items: NavigationItem[];
  children: ReactNode;
}

interface MenuNode {
  key: string;
  label: string;
  icon?: ReactNode;
  children?: MenuNode[];
}

const groupKeyOf = (item: NavigationItem) => `group:${item.group ?? ''}`;
const subGroupKeyOf = (item: NavigationItem) => `group:${item.group ?? ''}/sub:${item.subGroup ?? ''}`;

/**
 * 业务系统与管理后台共用的响应式页面壳。
 *
 * 菜单支持三级结构：一级业务分组（group）→ 二级业务分组（subGroup）→ 页面；
 * 未分组的项作为顶层叶子。提供菜单内搜索；Header 左侧为全站统一的回退/前进/刷新，
 * Header 下方提供面包屑（系统名 → 分组 → 二级分组 → 页面）。
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
  const [searchKeyword, setSearchKeyword] = useState('');
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

  /** 菜单结构：首页 + 顶层叶子 + 按业务分组收拢的子菜单（分组内可再含二级分组）；搜索关键字非空时扁平显示命中项。 */
  const menuItems = useMemo<MenuProps['items']>(() => {
    const homeItem: MenuNode = { key: homePath, label: '系统首页', icon: <AppstoreOutlined /> };
    if (searchKeyword.trim()) {
      const keyword = searchKeyword.trim();
      const matched = visibleItems.filter((item) => item.label.includes(keyword) || item.path.includes(keyword));
      return [homeItem, ...matched.map((item) => ({ key: item.path, label: item.label }))];
    }
    const topLevelLeaves: MenuNode[] = [];
    const groups = new Map<string, { children: MenuNode[]; subIndex: Map<string, MenuNode> }>();
    for (const item of visibleItems) {
      const leaf: MenuNode = { key: item.path, label: item.label };
      if (!item.group) {
        topLevelLeaves.push(leaf);
        continue;
      }
      let group = groups.get(item.group);
      if (!group) {
        group = { children: [], subIndex: new Map() };
        groups.set(item.group, group);
      }
      if (!item.subGroup) {
        group.children.push(leaf);
        continue;
      }
      const sub = group.subIndex.get(item.subGroup);
      if (sub) {
        sub.children?.push(leaf);
      } else {
        const node: MenuNode = { key: subGroupKeyOf(item), label: item.subGroup, children: [leaf] };
        group.subIndex.set(item.subGroup, node);
        group.children.push(node);
      }
    }
    return [
      homeItem,
      ...topLevelLeaves,
      ...[...groups.entries()].map(([group, { children: groupChildren }]) => ({
        key: `group:${group}`,
        label: group,
        children: groupChildren,
      })),
    ];
  }, [homePath, searchKeyword, visibleItems]);

  const selectedKeys = useMemo(() => [current?.path ?? homePath], [current, homePath]);
  /** 当前页祖先分组 key（直链/刷新时自动展开）；用户手动折叠由受控 openKeys 保留。 */
  const currentAncestorKeys = useMemo(() => {
    if (!current?.group) {
      return [];
    }
    return current.subGroup ? [groupKeyOf(current), subGroupKeyOf(current)] : [groupKeyOf(current)];
  }, [current]);
  const [openKeys, setOpenKeys] = useState<string[]>(currentAncestorKeys);
  useEffect(() => {
    setOpenKeys((previous) => [...new Set([...previous, ...currentAncestorKeys])]);
  }, [currentAncestorKeys]);

  const onMenuSelect: MenuProps['onClick'] = ({ key }) => {
    setMobileNavOpen(false);
    setSearchKeyword('');
    navigate(key);
  };

  const handleLogout = async () => {
    await logout();
    feedback.success('已退出登录');
  };

  const breadcrumbItems = [
    { title: systemName },
    ...(current?.group ? [{ title: current.group }] : []),
    ...(current?.subGroup ? [{ title: current.subGroup }] : []),
    ...(current ? [{ title: current.label }] : []),
  ];

  const navigation = (
    <>
      <div style={{ padding: '8px 12px' }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索菜单"
          aria-label="搜索菜单"
          value={searchKeyword}
          onChange={(event) => setSearchKeyword(event.target.value)}
        />
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
            <Typography.Text strong>{systemName}</Typography.Text>
          </Space>
          <Space>
            <Button type="text" icon={<AppstoreOutlined />} onClick={() => navigate('/portal')}>
              门户
            </Button>
            <Button type="text" icon={<UserOutlined />} onClick={() => navigate('/me')}>
              {user?.name ?? '个人中心'}
            </Button>
            <Button type="text" icon={<LogoutOutlined />} aria-label="退出登录" onClick={() => void handleLogout()} />
          </Space>
        </Header>
        <Content style={{ padding: screens.lg ? 24 : 16, maxWidth: 1680, width: '100%', margin: '0 auto' }}>
          {current ? (
            <Breadcrumb style={{ marginBottom: 16 }} items={breadcrumbItems} />
          ) : null}
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
