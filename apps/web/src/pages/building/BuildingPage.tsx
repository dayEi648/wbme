import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';

/**
 * 系统建设中占位页（门户入口可见 ≠ 可进入，主 PRD §2.1）。
 * 业务系统页面随 T9-5~T9-7 推进；已登录用户点击入口时展示占位说明，
 * 不再落入登录页兜底。
 */
export default function BuildingPage() {
  const navigate = useNavigate();
  return (
    <Result
      status="info"
      title="系统建设中"
      subTitle="该系统正在建设中，敬请期待。"
      extra={
        <Button type="primary" onClick={() => navigate('/portal')}>
          返回门户
        </Button>
      }
    />
  );
}
