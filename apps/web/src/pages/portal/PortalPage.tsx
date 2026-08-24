import { Badge, Button, Card, Drawer, Space, Tag, Tooltip, Typography } from 'antd';
import { BellOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HistoryNavButtons } from '../../components/HistoryNavButtons';
import { ConfirmAction } from '../../components/ConfirmAction';
import { ApiError, http } from '../../request/http';
import { useFeedback } from '../../request/feedback';
import { useSession } from '../../request/session';

interface SystemEntry {
  code: string;
  name: string;
  productStatus: 'OPEN' | 'COMING_SOON';
  hasPermission: boolean;
  entryUrl: string;
}

interface PortalData {
  brand: { name: string };
  user: { id: number; name: string; phoneMasked: string } | null;
  systems: SystemEntry[];
  announcement: { title: string; content: string | null; publishedAt: string | null } | null;
  badgeBySystem: Record<string, number>;
}

/**
 * 统一门户（base PRD §5）：WBME 品牌 + 按权限推导的系统入口 + 公告入口 + 个人中心。
 * 入口可见 ≠ 可进入："即将上线"展示状态但不可进入。
 */
export default function PortalPage() {
  const feedback = useFeedback();
  const navigate = useNavigate();
  const { logout } = useSession();
  const [portal, setPortal] = useState<PortalData | null>(null);
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  /** 软刷新：递增后重新拉取门户数据（入口/角标/公告）。 */
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    void http
      .get<PortalData>('/portal', { active: true })
      .then(setPortal)
      .catch((error) => {
        if (error instanceof ApiError) {
          feedback.error(error);
        }
      });
  }, [feedback, refreshKey]);

  async function handleLogout() {
    await logout();
    feedback.success('已退出登录');
  }

  return (
    <div style={{ minHeight: '100vh', maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <HistoryNavButtons onRefresh={() => setRefreshKey((value) => value + 1)} />
        <Space>
          <Button icon={<BellOutlined />} onClick={() => setAnnouncementOpen(true)}>
            系统公告
          </Button>
          <Button icon={<UserOutlined />} onClick={() => navigate('/me')}>
            个人中心
          </Button>
          <ConfirmAction title="确认退出登录？" description="退出后需要重新登录才能访问系统。" okText="退出登录" onConfirm={() => void handleLogout()}>
            <Button icon={<LogoutOutlined />}>
              退出
            </Button>
          </ConfirmAction>
        </Space>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
        {portal?.systems
          // 入口可见规则：仅展示当前用户拥有至少一项功能授权的系统（base PRD §5）
          .filter((system) => system.hasPermission)
          .map((system) => (
            <Card
              key={system.code}
              hoverable={system.productStatus === 'OPEN'}
              onClick={() => {
                if (system.productStatus === 'OPEN') {
                  navigate(system.entryUrl);
                }
              }}
              style={{ cursor: system.productStatus === 'OPEN' ? 'pointer' : 'not-allowed' }}
            >
              <Space direction="vertical" size="small">
                <Typography.Title level={5} style={{ margin: 0 }}>
                  {system.name}
                </Typography.Title>
                <Space size="small">
                  {system.productStatus === 'COMING_SOON' && (
                    <Tooltip title="系统尚未开放，暂时无法进入">
                      <Tag color="orange" style={{ cursor: 'not-allowed' }}>即将上线</Tag>
                    </Tooltip>
                  )}
                  {/* 待办角标：按系统拆分（base PRD §5：系统入口展示各自待处理数量） */}
                  <Badge count={portal.badgeBySystem[system.code] ?? 0} showZero={false} size="small" />
                </Space>
              </Space>
            </Card>
          ))}
      </div>

      <Drawer title="系统公告" open={announcementOpen} onClose={() => setAnnouncementOpen(false)} width="min(92vw, 420px)">
        {portal?.announcement ? (
          <Space direction="vertical" size="middle">
            <Typography.Title level={5}>{portal.announcement.title}</Typography.Title>
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
              {portal.announcement.content ?? ''}
            </Typography.Paragraph>
          </Space>
        ) : (
          <Typography.Text type="secondary">暂无公告</Typography.Text>
        )}
      </Drawer>
    </div>
  );
}
