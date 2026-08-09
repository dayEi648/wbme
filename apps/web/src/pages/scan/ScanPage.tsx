import { Card, Result, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import { useSession } from '../../request/session';

const SCAN_PUBLIC_ID_SESSION_KEY = 'wbme.scan.public-id';

/**
 * 二维码扫码入口（asset PRD §11）。
 *
 * 公开标识只从 fragment 读取，随后立即清除地址栏；未登录时仅限当前标签页 sessionStorage 暂存，
 * 登录成功后解析并清除，绝不写入 localStorage、Cookie 或前端日志。
 */
export default function ScanPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const feedback = useFeedback();
  const { user, loading } = useSession();
  const started = useRef(false);
  const [state, setState] = useState<'waiting' | 'resolving' | 'success' | 'failed'>('waiting');

  useEffect(() => {
    const fragment = location.hash.replace(/^#/, '');
    if (fragment) {
      sessionStorage.setItem(SCAN_PUBLIC_ID_SESSION_KEY, fragment);
      window.history.replaceState(null, '', '/scan');
    }
  }, [location.hash]);

  useEffect(() => {
    if (loading || started.current) return;
    const publicId = sessionStorage.getItem(SCAN_PUBLIC_ID_SESSION_KEY);
    if (!publicId) {
      setState('failed');
      return;
    }
    if (!user) {
      navigate('/login', { replace: true, state: { from: '/scan' } });
      return;
    }
    started.current = true;
    setState('resolving');
    void http.post<{ targetType?: string }>('/qr-codes/parse', { publicId }, { service: 'asset' }).then((result) => {
      sessionStorage.removeItem(SCAN_PUBLIC_ID_SESSION_KEY);
      setState('success');
      if (result.targetType === 'SCAN_CATALOG') {
        navigate('/asset/claims', { replace: true });
      } else {
        navigate('/asset/assets', { replace: true });
      }
    }).catch((error) => {
      sessionStorage.removeItem(SCAN_PUBLIC_ID_SESSION_KEY);
      setState('failed');
      feedback.error(error, '二维码无效或当前不可使用');
    });
  }, [feedback, loading, navigate, user]);

  if (state === 'waiting' || state === 'resolving') {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin size="large" tip={state === 'resolving' ? '正在验证二维码...' : '正在准备扫码...'} /></div>;
  }
  return <Card style={{ maxWidth: 480, margin: '80px auto' }}><Result status={state === 'success' ? 'success' : 'error'} title={state === 'success' ? '二维码验证成功' : '二维码无效'} subTitle={state === 'success' ? '正在进入对应业务页面。' : '请重新扫描有效二维码或联系管理员。'} /></Card>;
}
