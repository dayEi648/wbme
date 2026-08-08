import { Typography } from 'antd';

/** 前端骨架根组件（T0-9）：主题、路由与页面体系在 T9-1～T9-7 落地 */
export default function App() {
  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={2}>WBME 企业管理平台</Typography.Title>
      <Typography.Paragraph type="secondary">前端工程骨架已就绪（T0-9）</Typography.Paragraph>
    </div>
  );
}
