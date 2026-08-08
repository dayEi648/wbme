import { Navigate, Route, Routes } from 'react-router-dom';
import LoginPage from './pages/login/LoginPage';
import ActivatePage from './pages/activate/ActivatePage';
import ActivateCompletePage from './pages/activate/ActivateCompletePage';
import RegisterPage from './pages/register/RegisterPage';
import ResetPasswordPage, { ResetCompletePage } from './pages/reset-password/ResetPasswordPage';
import RebindPage, { RebindCompletePage } from './pages/rebind/RebindPage';
import PortalPage from './pages/portal/PortalPage';
import MePage from './pages/me/MePage';
import BuildingPage from './pages/building/BuildingPage';
import { RequireAuth } from './request/session';

/** 路由表（T9-3 认证与门户；业务系统页面随对应后端检查点推进） */
export default function App() {
  return (
    <Routes>
      {/* 公开：登录 / 激活 / 注册 / 重置 / 换绑（凭证 fragment 流程） */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/activate" element={<ActivatePage />} />
      <Route path="/activate/complete" element={<ActivateCompletePage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/reset-password/complete" element={<ResetCompletePage />} />
      <Route path="/rebind" element={<RebindPage />} />
      <Route path="/rebind/complete" element={<RebindCompletePage />} />

      {/* 根路径 → 门户（未登录由 RequireAuth 重定向登录页） */}
      <Route path="/" element={<Navigate to="/portal" replace />} />

      {/* 登录态：门户 / 个人中心（业务系统页面随 T9-5~T9-7 推进） */}
      <Route
        path="/portal"
        element={
          <RequireAuth>
            <PortalPage />
          </RequireAuth>
        }
      />
      <Route
        path="/me"
        element={
          <RequireAuth>
            <MePage />
          </RequireAuth>
        }
      />

      {/* 未匹配路由：建设中占位（业务系统入口已可见但页面未上线；不再兜底到登录页） */}
      <Route path="*" element={<BuildingPage />} />
    </Routes>
  );
}
