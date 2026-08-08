import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './request/session';
import theme from '../../../docs/for-frontend/ant-design/theme.json';

// 主题：项目唯一主题种子配置（主 PRD §10.1、docs/for-frontend/ant-design/theme.json）
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('缺少 #root 挂载节点');
}

createRoot(rootElement).render(
  <StrictMode>
    <ConfigProvider theme={theme} locale={zhCN}>
      <AntApp>
        <BrowserRouter>
          <SessionProvider>
            <App />
          </SessionProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
