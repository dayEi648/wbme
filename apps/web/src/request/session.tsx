import { Spin } from 'antd';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { http, setSessionExpiredHandler } from './http';
import { useFeedback } from './feedback';

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
  functionCodes: string[];
}

interface SessionContextValue {
  user: CurrentUser | null;
  /** 当前账号是否已绑定钉钉（账户安全页展示用；扫码登录与手机号自动同步依赖该绑定）。 */
  hasDingtalkBinding: boolean;
  functionCodes: ReadonlySet<string>;
  /** 前端显隐辅助；不取代服务端授权。 */
  can: (functionCode: string) => boolean;
  loading: boolean;
  /** 刷新当前身份（登录/激活完成后调用） */
  refresh: () => Promise<void>;
  /** 登出并回登录页 */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** 目录中明确声明的维护权限隐含只读权限；用于前端入口显隐，不替代服务端授权推导。 */
const IMPLIED_FUNCTION_CODES: Readonly<Record<string, readonly string[]>> = {
  fixed_asset_view: ['fixed_asset_maintain'],
  finance_view: ['finance_maintain'],
};

/** 会话状态提供者：启动时校验登录态；会话失效统一处理（跳登录） */
export function SessionProvider({ children }: { children: ReactNode }) {
  const feedback = useFeedback();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [hasDingtalkBinding, setHasDingtalkBinding] = useState(false);
  const [functionCodes, setFunctionCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const goLogin = useCallback(() => {
    setUser(null);
    setHasDingtalkBinding(false);
    setFunctionCodes([]);
    navigate('/login', { replace: true });
  }, [navigate]);

  const refresh = useCallback(async () => {
    try {
      const me = await http.get<MeResponse>('/auth/me');
      setUser(me.user);
      setHasDingtalkBinding(me.hasDingtalkBinding);
      setFunctionCodes(me.functionCodes);
    } catch {
      setUser(null);
      setHasDingtalkBinding(false);
      setFunctionCodes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 会话中途失效（含账号注销/待激活）：明确提示后跳登录，不产生无提示跳转（base PRD §3）；
  // silent（未登录首访的 SESSION_EXPIRED）仅清理本地态并跳转，不弹提示
  useEffect(() => {
      setSessionExpiredHandler((messageText?: string, silent?: boolean) => {
        setUser(null);
        setHasDingtalkBinding(false);
        setFunctionCodes([]);
        if (!silent) {
          feedback.error(new Error(messageText ?? '登录状态已失效，请重新登录'), messageText ?? '登录状态已失效，请重新登录');
      }
      navigate('/login', { replace: true });
    });
    void refresh();
  }, [feedback, navigate, refresh]);

  const logout = useCallback(async () => {
    try {
      await http.post('/auth/logout', {});
    } catch {
      // 登出失败不阻塞本地清理
    }
    goLogin();
  }, [goLogin]);

  const grantedFunctions = useMemo(() => new Set(functionCodes), [functionCodes]);
  const value = useMemo(
    () => ({
      user,
      hasDingtalkBinding,
      functionCodes: grantedFunctions,
      can: (functionCode: string) => user?.isSuperAdmin === true || grantedFunctions.has(functionCode) || (IMPLIED_FUNCTION_CODES[functionCode] ?? []).some((impliedBy) => grantedFunctions.has(impliedBy)),
      loading,
      refresh,
      logout,
    }),
    [user, hasDingtalkBinding, grantedFunctions, loading, refresh, logout],
  );
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
