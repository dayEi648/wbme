import { Badge, Button, Card, Drawer, Space, Tag, Typography } from 'antd';
import { BellOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

  useEffect(() => {
    void http
      .get<PortalData>('/portal', { active: true })
      .then(setPortal)
      .catch((error) => {
        if (error instanceof ApiError) {
          feedback.error(error);
        }
      });
  }, [feedback]);

  async function handleLogout() {
    await logout();
    feedback.success('已退出登录');
  }

  return (
    <div style={{ minHeight: '100vh', maxWidth: 960, margin: '0 auto', padding: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <div>
          <Typography.Title level={2} style={{ marginBottom: 0 }}>
            {portal?.brand.name ?? 'WBME 企业管理平台'}
          </Typography.Title>
          <Typography.Text type="secondary">欢迎，{portal?.user?.name}</Typography.Text>
        </div>
        <Space>
          <Button icon={<BellOutlined />} onClick={() => setAnnouncementOpen(true)}>
            系统公告
          </Button>
          <Button icon={<UserOutlined />} onClick={() => navigate('/me')}>
            个人中心
          </Button>
          <Button icon={<LogoutOutlined />} onClick={handleLogout}>
            退出
          </Button>
        </Space>
      </div>

      <Typography.Title level={4}>系统入口</Typography.Title>
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
                  {system.productStatus === 'COMING_SOON' && <Tag color="orange">即将上线</Tag>}
                  {/* 待办角标：按系统拆分（base PRD §5：系统入口展示各自待处理数量） */}
                  <Badge count={portal.badgeBySystem[system.code] ?? 0} showZero={false} size="small" />
                </Space>
              </Space>
            </Card>
          ))}
      </div>

      <Drawer title="系统公告" open={announcementOpen} onClose={() => setAnnouncementOpen(false)} width={420}>
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
