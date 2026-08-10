import { Card, Col, Row, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../request/session';
import type { NavigationItem } from './AppShell';

interface SystemHomeProps {
  systemName: string;
  welcome: string;
  items: NavigationItem[];
}

/** 高频入口：每个业务分组取第一项，另含审批中心与系统设置；不重复渲染全量菜单。 */
function featuredItems(items: NavigationItem[]): NavigationItem[] {
  const groups = new Map<string, NavigationItem>();
  for (const item of items) {
    const group = item.group ?? '常用';
    if (!groups.has(group)) {
      groups.set(group, item);
    }
  }
  const featured = [...groups.values()];
  const special = items.filter((item) => /审批中心|系统设置/.test(item.label));
  const seen = new Set(featured.map((item) => item.key));
  for (const item of special) {
    if (!seen.has(item.key)) {
      featured.push(item);
    }
  }
  return featured.slice(0, 8);
}

/** 各系统统一首页：欢迎信息 + 按权限过滤的常用功能快捷入口（主 PRD §2.1）。 */
export function SystemHome({ systemName, welcome, items }: SystemHomeProps) {
  const { can } = useSession();
  const navigate = useNavigate();
  const available = items.filter((item) => !item.permission || (Array.isArray(item.permission) ? item.permission.some((code) => can(code)) : can(item.permission)));
  return (
    <>
      <Typography.Title level={3}>{systemName}</Typography.Title>
      <Typography.Paragraph type="secondary">{welcome}</Typography.Paragraph>
      <Typography.Title level={5} style={{ marginTop: 24 }}>快捷入口</Typography.Title>
      <Row gutter={[16, 16]}>
        {featuredItems(available).map((item) => (
          <Col key={item.key} xs={24} sm={12} lg={8}>
            <Card hoverable onClick={() => navigate(item.path)}>
              <Typography.Text strong>{item.label}</Typography.Text>
            </Card>
          </Col>
        ))}
      </Row>
    </>
  );
}
