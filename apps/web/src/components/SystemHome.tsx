import { Card, Col, Row, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../request/session';
import type { NavigationItem } from './AppShell';

interface SystemHomeProps {
  items: NavigationItem[];
}

/** 高频入口：每个业务分组（顶层祖先分组）取第一项，另含审批中心与系统设置；不重复渲染全量菜单。 */
function featuredItems(items: NavigationItem[]): NavigationItem[] {
  const groups = new Map<string, NavigationItem>();
  for (const item of items) {
    const group = item.groupPath?.[0] ?? item.group ?? '常用';
    if (!groups.has(group)) {
      groups.set(group, item);
    }
  }
  const featured = [...groups.values()];
  // 按稳定 key 匹配特殊入口（菜单管理可改中文名，不能依赖 label 文案）
  const special = items.filter((item) => item.key === 'approval' || item.key === 'config' || item.key === 'settings');
  const seen = new Set(featured.map((item) => item.key));
  for (const item of special) {
    if (!seen.has(item.key)) {
      featured.push(item);
    }
  }
  return featured.slice(0, 8);
}

/** 各系统统一首页：欢迎信息 + 按权限过滤的常用功能快捷入口（主 PRD §2.1）。 */
export function SystemHome({ items }: SystemHomeProps) {
  const { can } = useSession();
  const navigate = useNavigate();
  const available = items.filter((item) => !item.permission || (Array.isArray(item.permission) ? item.permission.some((code) => can(code)) : can(item.permission)));
  return (
    <Row gutter={[16, 16]}>
      {featuredItems(available).map((item) => (
        <Col key={item.key} xs={24} sm={12} lg={8}>
          <Card hoverable onClick={() => navigate(item.path)}>
            <Typography.Text strong>{item.label}</Typography.Text>
          </Card>
        </Col>
      ))}
    </Row>
  );
}
