import { useCallback, useEffect, useState } from 'react';
import { useFeedback } from '../../request/feedback';
import { ApiError, http } from '../../request/http';

/** GET /me 聚合返回（base PRD §6）。 */
export interface MeData {
  user: {
    id: number;
    name: string;
    gender: 'MALE' | 'FEMALE';
    phoneMasked: string;
    status: string;
    isSuperAdmin: boolean;
    createdAt: string;
  };
  departments: Array<{ id: number; name: string }>;
  positions: Array<{ id: number; name: string }>;
  canApplyPositionChange: boolean;
  pendingProfileChange: boolean;
}

/** 拉取个人中心聚合数据；reload 用于资料直改生效后重新拉取（同时刷新待审批状态）。 */
export function useMeData() {
  const feedback = useFeedback();
  const [me, setMe] = useState<MeData | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void http
      .get<MeData>('/me', { active: true })
      .then((data) => {
        if (!cancelled) {
          setMe(data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && error instanceof ApiError) {
          feedback.error(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [feedback, reloadKey]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);
  return { me, reload };
}
