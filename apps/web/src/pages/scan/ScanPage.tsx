import { Card, Result, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import { useSession } from '../../request/session';

const SCAN_PUBLIC_ID_SESSION_KEY = 'wbme.scan.public-id';

/**
 * 根据已由服务端校验的二维码目标决定前端入口地址。
 *
 * @param targetType 二维码目标类型
 * @param targetId 业务目标 ID；申领目录没有目标 ID
 * @param can 当前会话的功能权限判断函数
 * @returns 应跳转的系统内路径
 */
export function resolveScanTargetPath(
  targetType: string | undefined,
  targetId: number | null | undefined,
  can: (permission: string) => boolean,
): string {
  if (targetType === 'ASSET' && targetId !== null && targetId !== undefined) {
    const base = can('my_assets') ? '/asset/my-assets' : '/asset/assets';
    return `${base}?assetId=${targetId}`;
  }
  if (targetType === 'INVENTORY_ITEM' && targetId !== null && targetId !== undefined) {
    return `/asset/claims?inventoryItemId=${targetId}`;
  }
  return '/asset/claims';
}

/**
 * 二维码扫码入口（asset PRD §11）。
 *
 * 公开标识只从 fragment 读取，随后立即清除地址栏；未登录时仅限当前标签页 sessionStorage 暂存，
 * 登录成功后解析并清除，绝不写入 localStorage、Cookie 或前端日志。
 * 解析成功后按目标类型跳转：固定资产 → 资产详情；库存条目/申领目录 → 申领入口。
 */
export default function ScanPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const feedback = useFeedback();
  const { user, loading, can } = useSession();
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
    void http.post<{ targetType?: string; targetId?: number | null }>('/qr-codes/parse', { publicId }, { service: 'asset' }).then((result) => {
      sessionStorage.removeItem(SCAN_PUBLIC_ID_SESSION_KEY);
      setState('success');
      navigate(resolveScanTargetPath(result.targetType, result.targetId, can), { replace: true });
    }).catch((error) => {
      sessionStorage.removeItem(SCAN_PUBLIC_ID_SESSION_KEY);
      setState('failed');
      feedback.error(error, '二维码无效或当前不可使用');
    });
  }, [can, feedback, loading, navigate, user]);

  if (state === 'waiting' || state === 'resolving') {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin size="large" tip={state === 'resolving' ? '正在验证二维码...' : '正在准备扫码...'} /></div>;
  }
  return <Card style={{ maxWidth: 480, margin: '80px auto' }}><Result status={state === 'success' ? 'success' : 'error'} title={state === 'success' ? '二维码验证成功' : '二维码无效'} subTitle={state === 'success' ? '正在进入对应业务页面。' : '请重新扫描有效二维码或联系管理员。'} /></Card>;
}
