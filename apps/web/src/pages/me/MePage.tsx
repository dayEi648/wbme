import { Breadcrumb } from 'antd';
import { useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { HistoryNavButtons } from '../../components/HistoryNavButtons';
import { PageTabs } from '../../components/PageTabs';
import { OperationLogsSection } from './OperationLogsSection';
import { PositionApplicationsSection } from './PositionApplicationsSection';
import { ProfileSection } from './ProfileSection';
import { SecuritySection } from './SecuritySection';

/**
 * 个人中心（base PRD §6）：顶部 Tab 分区 —— 个人资料（只读展示，弹窗修改姓名/性别）、
 * 账户安全（修改密码、手机号只读展示+钉钉同步说明）、岗位申请（发起申请+历史记录）、我的日志。
 * 旧子路由（/me/position-applications、/me/operation-logs）重定向到对应 tab，保持直链可用。
 */
export default function MePage() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] ?? '';
  /** 软刷新：重挂载当前子页面重新拉数。 */
  const [refreshKey, setRefreshKey] = useState(0);

  const body = useMemo(() => {
    switch (section) {
      case 'position-applications':
        return <Navigate to="/me?tab=positions" replace />;
      case 'operation-logs':
        return <Navigate to="/me?tab=logs" replace />;
      default:
        return (
          <PageTabs
            items={[
              { key: 'profile', label: '个人资料', children: <ProfileSection /> },
              { key: 'security', label: '账户安全', children: <SecuritySection /> },
              { key: 'positions', label: '岗位申请', children: <PositionApplicationsSection /> },
              { key: 'logs', label: '我的日志', children: <OperationLogsSection /> },
            ]}
          />
        );
    }
  }, [section]);

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <HistoryNavButtons onRefresh={() => setRefreshKey((value) => value + 1)} />
        <Breadcrumb style={{ marginLeft: 12 }} items={[{ title: '门户', href: '/portal' }, { title: '个人中心' }]} />
      </div>
      <div key={refreshKey}>{body}</div>
    </div>
  );
}
