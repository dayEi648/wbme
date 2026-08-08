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

  useEffect(() => {
    setSessionExpiredHandler(goLogin);
    void refresh();
  }, [goLogin, refresh]);

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
    return null; // 校验中（避免闪烁）
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}
