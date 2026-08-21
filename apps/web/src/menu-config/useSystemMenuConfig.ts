import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NavigationItem } from '../components/AppShell';
import { useFeedback } from '../request/feedback';
import { http } from '../request/http';
import { applyMenuConfig, EMPTY_MENU_CONFIG } from './merge';
import type { MenuSystemCode, SystemMenuConfig } from './types';

/**
 * 拉取并合并某系统的导航菜单展示配置（主 PRD §2.1 菜单管理）。
 *
 * 配置加载失败或尚未返回时回退代码默认菜单——菜单永不可因配置异常而不可用。
 * `reload()` 用于菜单管理保存/恢复默认后让当前页面立即生效。
 */
export function useSystemMenuConfig(
  systemCode: MenuSystemCode,
  defaults: NavigationItem[],
): { items: NavigationItem[]; reload: () => void } {
  const feedback = useFeedback();
  const [config, setConfig] = useState<SystemMenuConfig>(EMPTY_MENU_CONFIG);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await http.get<Partial<SystemMenuConfig>>(`/system-menu-configs/${systemCode}`, { active: true });
        if (!cancelled) {
          setConfig({ groups: result.groups ?? [], items: result.items ?? [] });
        }
      } catch (error) {
        if (!cancelled) {
          setConfig(EMPTY_MENU_CONFIG);
          feedback.error(error, '菜单配置加载失败，已使用默认菜单');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [systemCode, version, feedback]);

  const items = useMemo(() => applyMenuConfig(defaults, config), [defaults, config]);
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  return { items, reload };
}
