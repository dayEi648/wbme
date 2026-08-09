import { AppstoreOutlined, LogoutOutlined, MenuOutlined, UserOutlined } from '@ant-design/icons';
import { Avatar, Button, Drawer, Grid, Layout, Menu, Space, Typography, theme, type MenuProps } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useFeedback } from '../request/feedback';
import { useSession } from '../request/session';

const { Header, Sider, Content } = Layout;

export interface NavigationItem {
  key: string;
  label: string;
  path: string;
  /** 单个功能或“具备任一即可”的功能集合；仅用于体验层菜单显隐。 */
  permission?: string | string[];
}

interface AppShellProps {
  systemName: string;
  homePath: string;
  items: NavigationItem[];
  children: ReactNode;
}

/**
 * 业务系统与管理后台共用的响应式页面壳。
 *
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

  const menuItems = useMemo<MenuProps['items']>(
    () => [
      { key: homePath, label: '系统首页', icon: <AppstoreOutlined /> },
      ...items.filter((item) => !item.permission || (Array.isArray(item.permission) ? item.permission.some((code) => can(code)) : can(item.permission))).map((item) => ({ key: item.path, label: item.label })),
    ],
    [can, homePath, items],
  );

  const selectedKeys = useMemo(() => {
    const exact = items.find((item) => location.pathname === item.path);
    if (exact) {
      return [exact.path];
    }
    const nested = [...items].sort((left, right) => right.path.length - left.path.length).find((item) => location.pathname.startsWith(`${item.path}/`));
    return [nested?.path ?? homePath];
  }, [homePath, items, location.pathname]);

  const onMenuSelect: MenuProps['onClick'] = ({ key }) => {
    setMobileNavOpen(false);
    navigate(key);
  };

  const handleLogout = async () => {
    await logout();
    feedback.success('已退出登录');
  };

  const navigation = <Menu mode="inline" selectedKeys={selectedKeys} items={menuItems} onClick={onMenuSelect} />;

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      {screens.lg ? <Sider width={224} theme="light">{navigation}</Sider> : null}
      <Layout>
        <Header style={{ background: token.colorBgContainer, display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingInline: 16 }}>
          <Space>
            {!screens.lg ? <Button type="text" icon={<MenuOutlined />} aria-label="打开导航" onClick={() => setMobileNavOpen(true)} /> : null}
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
        <Content style={{ padding: screens.lg ? 24 : 16, maxWidth: 1680, width: '100%', margin: '0 auto' }}>{children}</Content>
      </Layout>
      <Drawer title={systemName} open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} placement="left" width={280} styles={{ body: { padding: 0 } }}>
        <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Avatar icon={<UserOutlined />} />
          <Typography.Text>{user?.name}</Typography.Text>
        </div>
        {navigation}
      </Drawer>
    </Layout>
  );
}
