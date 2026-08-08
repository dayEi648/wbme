import { ConfigProvider } from 'antd';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// 主题种子配置在 T9-1 按 docs/for-frontend/ant-design/theme.json 接入（主 PRD §10.1）
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('缺少 #root 挂载节点');
}

createRoot(rootElement).render(
  <StrictMode>
    <ConfigProvider>
      <App />
    </ConfigProvider>
  </StrictMode>,
);
