import { Tabs } from 'antd';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession } from '../request/session';

export interface PageTabItem {
  key: string;
  label: string;
  /** 具备任一功能即可见；缺省始终可见。仅用于体验层显隐，接口鉴权仍在服务端。 */
  permission?: string | string[];
  children: ReactNode;
}

/**
 * 申请类业务页的统一 tab 容器（如"申领申请 / 历史记录"）。
 *
 * tab 状态落在 `?tab=` 查询参数上：刷新、回退/前进、外部直链（含旧路由重定向）均保持一致；
 * 切换时保留其它查询参数（如扫码带入的 inventoryItemId）。仅剩一个可见 tab 时直接渲染内容，不显示 tab 框架。
 */
export function PageTabs({ items }: { items: PageTabItem[] }) {
  const { can } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const visible = items.filter((item) => !item.permission || (Array.isArray(item.permission) ? item.permission.some((code) => can(code)) : can(item.permission)));
  if (visible.length <= 1) {
    return <>{visible[0]?.children ?? null}</>;
  }
  const requested = searchParams.get('tab');
  const fallbackKey = visible[0]?.key ?? '';
  const activeKey = requested !== null && visible.some((item) => item.key === requested) ? requested : fallbackKey;
  return (
    <Tabs
      activeKey={activeKey}
      onChange={(key) => {
        setSearchParams((previous) => {
          const next = new URLSearchParams(previous);
          next.set('tab', key);
          return next;
        });
      }}
      items={visible.map(({ key, label, children }) => ({ key, label, children }))}
    />
  );
}
