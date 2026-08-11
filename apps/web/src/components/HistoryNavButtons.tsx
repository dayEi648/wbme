import { ArrowLeftOutlined, ArrowRightOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Space } from 'antd';
import { useNavigate } from 'react-router-dom';

interface HistoryNavButtonsProps {
  /** 刷新行为；缺省整页重载。宿主页面应传软刷新（重挂载内容区）以保留 SPA 状态。 */
  onRefresh?: () => void;
}

/** 全站页头统一的历史导航按钮：回退 / 前进 / 刷新。 */
export function HistoryNavButtons({ onRefresh }: HistoryNavButtonsProps) {
  const navigate = useNavigate();
  return (
    <Space size={0}>
      <Button type="text" size="small" icon={<ArrowLeftOutlined />} aria-label="回退" title="回退" onClick={() => navigate(-1)} />
      <Button type="text" size="small" icon={<ArrowRightOutlined />} aria-label="前进" title="前进" onClick={() => navigate(1)} />
      <Button
        type="text"
        size="small"
        icon={<ReloadOutlined />}
        aria-label="刷新"
        title="刷新"
        onClick={onRefresh ?? (() => window.location.reload())}
      />
    </Space>
  );
}
