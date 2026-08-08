import { App as AntApp, Button, Card, Result, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ApiError, http } from '../../request/http';

/**
 * 激活入口页（base PRD §2）：
 * 读取 URL fragment 中的一次性凭证 → POST body 兑换（凭证只短暂存在于当前页面内存，
 * 兑换成功后立即从地址栏移除 fragment，不写入 localStorage/sessionStorage）→
 * 凭流程 Cookie 发起钉钉授权（ACTIVATION）。
 */
export default function ActivatePage() {
  const { message } = AntApp.useApp();
  const location = useLocation();
  const [state, setState] = useState<'redeeming' | 'redirecting' | 'failed'>('redeeming');
  const [errorMessage, setErrorMessage] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    const token = location.hash.replace(/^#/, '');
    if (!token) {
      setState('failed');
      setErrorMessage('激活链接缺少凭证，请联系管理员重新生成');
      return;
    }
    void (async () => {
      try {
        // 凭证仅此一次出现在请求体
        await http.post('/auth/activation/redeem', { token });
        // 兑换成功：立即清除地址栏 fragment（凭证不再停留）
        window.history.replaceState(null, '', '/activate');
        // 流程 Cookie 已下发（Path 限定激活流程），发起钉钉授权
        const { authorizeUrl } = await http.get<{ authorizeUrl: string }>('/auth/dingtalk/authorize?purpose=ACTIVATION');
        window.location.href = authorizeUrl;
      } catch (error) {
        // 兑换失败同样清除地址栏 fragment（凭证已失效，不滞留地址栏/截图/历史）
        window.history.replaceState(null, '', '/activate');
        setState('failed');
        setErrorMessage(error instanceof ApiError ? error.body.message : '兑换失败，请重试');
        message.error(error instanceof ApiError ? error.body.message : '兑换失败');
      }
    })();
  }, [location.hash, message]);

  if (state === 'redeeming') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="正在校验激活凭证..." />
      </div>
    );
  }
  if (state === 'redirecting') {
    return null; // 正在跳转钉钉授权
  }
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card style={{ width: 420 }}>
        <Result status="error" title="激活失败" subTitle={errorMessage} />
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          请联系管理员重新生成激活邀请
        </Typography.Paragraph>
        <Button type="primary" block href="/login">
          返回登录
        </Button>
      </Card>
    </div>
  );
}
