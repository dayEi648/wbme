import { Card, Col, Row, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../request/session';
import type { NavigationItem } from './AppShell';

interface SystemHomeProps {
  systemName: string;
  welcome: string;
  items: NavigationItem[];
}

/** 各系统统一首页：欢迎信息和按权限过滤的常用功能快捷入口。 */
export function SystemHome({ systemName, welcome, items }: SystemHomeProps) {
  const { can } = useSession();
  const navigate = useNavigate();
  const available = items.filter((item) => !item.permission || (Array.isArray(item.permission) ? item.permission.some((code) => can(code)) : can(item.permission)));
  return (
    <>
      <Typography.Title level={3}>{systemName}</Typography.Title>
      <Typography.Paragraph type="secondary">{welcome}</Typography.Paragraph>
      <Row gutter={[16, 16]}>
        {available.map((item) => (
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
