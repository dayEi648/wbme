import { App as AntApp, Spin } from 'antd';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { http, setSessionExpiredHandler } from './http';

/** 当前登录用户（服务端返回结构） */
export interface CurrentUser {
  id: number;
  name: string;
  gender: 'MALE' | 'FEMALE';
  phoneMasked: string;
  status: string;
  isSuperAdmin: boolean;
}

interface MeResponse {
  user: CurrentUser;
  hasDingtalkBinding: boolean;
}

interface SessionContextValue {
  user: CurrentUser | null;
  loading: boolean;
  /** 刷新当前身份（登录/激活完成后调用） */
  refresh: () => Promise<void>;
  /** 登出并回登录页 */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** 会话状态提供者：启动时校验登录态；会话失效统一处理（跳登录） */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { message } = AntApp.useApp();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const goLogin = useCallback(() => {
    setUser(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  const refresh = useCallback(async () => {
    try {
      const me = await http.get<MeResponse>('/auth/me');
      setUser(me.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // 会话中途失效（含账号注销/待激活）：明确提示后跳登录，不产生无提示跳转（base PRD §3）；
  // silent（未登录首访的 SESSION_EXPIRED）仅清理本地态并跳转，不弹提示
  useEffect(() => {
    setSessionExpiredHandler((messageText?: string, silent?: boolean) => {
      setUser(null);
      if (!silent) {
        message.error(messageText ?? '登录状态已失效，请重新登录');
      }
      navigate('/login', { replace: true });
    });
    void refresh();
  }, [message, navigate, refresh]);

  const logout = useCallback(async () => {
    try {
      await http.post('/auth/logout', {});
    } catch {
      // 登出失败不阻塞本地清理
    }
    goLogin();
  }, [goLogin]);

  const value = useMemo(() => ({ user, loading, refresh, logout }), [user, loading, refresh, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** 访问当前会话状态 */
export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession 必须在 SessionProvider 内使用');
  }
  return context;
}

/** 路由守卫：未登录重定向到登录页 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  const location = useLocation();
  if (loading) {
    // 会话校验中：全屏 loading 占位，避免白屏闪烁
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}
