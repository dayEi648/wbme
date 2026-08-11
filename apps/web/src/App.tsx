import { Spin } from 'antd';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './request/session';

const LoginPage = lazy(() => import('./pages/login/LoginPage'));
const ActivatePage = lazy(() => import('./pages/activate/ActivatePage'));
const ActivateCompletePage = lazy(() => import('./pages/activate/ActivateCompletePage'));
const RegisterPage = lazy(() => import('./pages/register/RegisterPage'));
const ResetPasswordPage = lazy(() => import('./pages/reset-password/ResetPasswordPage'));
const ResetCompletePage = lazy(() => import('./pages/reset-password/ResetPasswordPage').then((module) => ({ default: module.ResetCompletePage })));
const PortalPage = lazy(() => import('./pages/portal/PortalPage'));
const MePage = lazy(() => import('./pages/me/MePage'));
const BuildingPage = lazy(() => import('./pages/building/BuildingPage'));
const BackstagePage = lazy(() => import('./pages/backstage/BackstagePage'));
const AssetPage = lazy(() => import('./pages/asset/AssetPage'));
const HrPage = lazy(() => import('./pages/hr/HrPage'));
const FinPage = lazy(() => import('./pages/fin/FinPage'));
const ScanPage = lazy(() => import('./pages/scan/ScanPage'));

/** 路由表（认证与门户；业务系统页面） */
export default function App() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin size="large" /></div>}>
      <Routes>
      {/* 公开：登录 / 激活 / 注册 / 重置（凭证 fragment 流程） */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/activate" element={<ActivatePage />} />
      <Route path="/activate/complete" element={<ActivateCompletePage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/reset-password/complete" element={<ResetCompletePage />} />
      <Route path="/scan" element={<ScanPage />} />

      {/* 根路径 → 门户（未登录由 RequireAuth 重定向登录页） */}
      <Route path="/" element={<Navigate to="/portal" replace />} />

      {/* 登录态：门户 / 个人中心 / 业务系统页面 */}
      <Route
        path="/portal"
        element={
          <RequireAuth>
            <PortalPage />
          </RequireAuth>
        }
      />
      <Route
        path="/me/*"
        element={
          <RequireAuth>
            <MePage />
          </RequireAuth>
        }
      />

      {/* 管理后台与三项业务系统：各自通过稳定同源网关调用所属服务。 */}
      <Route path="/backstage/*" element={<RequireAuth><BackstagePage /></RequireAuth>} />
      <Route path="/asset/*" element={<RequireAuth><AssetPage /></RequireAuth>} />
      <Route path="/hr/*" element={<RequireAuth><HrPage /></RequireAuth>} />
      <Route path="/fin/*" element={<RequireAuth><FinPage /></RequireAuth>} />

      {/* 未匹配路由：建设中占位（业务系统入口已可见但页面未上线；不再兜底到登录页） */}
      <Route path="*" element={<BuildingPage />} />
      </Routes>
    </Suspense>
  );
}
