import { App as AntApp, theme } from 'antd';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ApiError, http } from './http';

/** 默认通知显示时长（秒）；运行时配置不可用时保持可预期的降级体验。 */
const DEFAULT_NOTIFICATION_DURATION_SECONDS = 5;
/** 前后端共同约束的通知时长边界，避免异常配置长期遮挡业务操作。 */
const MIN_NOTIFICATION_DURATION_SECONDS = 1;
const MAX_NOTIFICATION_DURATION_SECONDS = 60;

type NotificationKind = 'success' | 'info' | 'error';

interface NotificationRuntimeSettings {
  notificationDurationSeconds?: unknown;
}

/** 通用确认弹窗参数（与 Ant Design modal.confirm 对齐，但只暴露业务常用字段）。 */
export interface ConfirmOptions {
  title: ReactNode;
  content?: ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}

/** 统一页面反馈接口。 */
interface FeedbackContextValue {
  success: (content: string) => void;
  info: (content: string) => void;
  error: (error: unknown, fallback?: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmDanger: (title: string, content: ReactNode, okText?: string) => Promise<boolean>;
  /** 刷新通知显示时长；设置页保存后立即影响后续产生的通知。 */
  refreshNotificationDuration: () => Promise<void>;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

/**
 * 全站 Ant Design 反馈服务。
 *
 * 即时反馈统一使用 Ant Design Notification：固定在右侧、自动堆叠并带关闭进度。
 * 点击卡片会在居中 Modal 中展开同一条通知的完整文本。所有服务端文案都作为
 * React 文本节点处理，绝不当作 HTML 注入。
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { modal, notification } = AntApp.useApp();
  const { token } = theme.useToken();
  const notificationDurationSeconds = useRef(DEFAULT_NOTIFICATION_DURATION_SECONDS);

  const refreshNotificationDuration = useCallback(async () => {
    try {
      const settings = await http.get<NotificationRuntimeSettings>('/runtime-settings/notifications');
      const duration = settings.notificationDurationSeconds;
      if (typeof duration === 'number'
        && Number.isInteger(duration)
        && duration >= MIN_NOTIFICATION_DURATION_SECONDS
        && duration <= MAX_NOTIFICATION_DURATION_SECONDS) {
        notificationDurationSeconds.current = duration;
      }
    } catch {
      // 公共运行参数读取失败不影响当前操作；维持默认 5 秒，避免反馈服务自身再产生通知。
    }
  }, []);

  useEffect(() => {
    void refreshNotificationDuration();
  }, [refreshNotificationDuration]);

  const showNotification = useCallback((kind: NotificationKind, title: string, content: string) => {
    const accentColor = kind === 'success'
      ? token.colorSuccess
      : kind === 'error'
        ? token.colorError
        : token.colorInfo;
    notification[kind]({
      title,
      description: content,
      placement: 'topRight',
      duration: notificationDurationSeconds.current,
      showProgress: true,
      pauseOnHover: true,
      closable: true,
      role: kind === 'error' ? 'alert' : 'status',
      classNames: {
        root: `wbme-floating-notification wbme-floating-notification--${kind}`,
        title: 'wbme-floating-notification__title',
        description: 'wbme-floating-notification__description',
        progress: 'wbme-floating-notification__progress',
      },
      style: {
        width: 'min(408px, calc(100vw - 32px))',
        background: token.colorBgElevated,
        borderColor: token.colorBorderSecondary,
        borderInlineStart: `4px solid ${accentColor}`,
        borderRadius: token.borderRadiusLG,
        boxShadow: token.boxShadowSecondary,
      },
      onClick: () => {
        modal.info({
          title,
          content: <div className="wbme-notification-detail-content">{content}</div>,
          okText: '关闭',
        });
      },
    });
  }, [modal, notification, token]);

  const success = useCallback((content: string) => {
    showNotification('success', '操作成功', content);
  }, [showNotification]);

  const info = useCallback((content: string) => {
    showNotification('info', '提示', content);
  }, [showNotification]);

  const error = useCallback((errorValue: unknown, fallback = '操作失败，请稍后重试') => {
    if (errorValue instanceof ApiError) {
      if (errorValue.type === 'SYSTEM') {
        showNotification('error', '系统处理失败', `请稍后重试。请求编号：${errorValue.body.requestId}`);
        return;
      }
      showNotification('error', '操作失败', errorValue.body.message || fallback);
      return;
    }
    showNotification('error', '操作失败', fallback);
  }, [showNotification]);

  const confirm = useCallback(({ title, content, okText = '确认', cancelText = '取消', danger = false }: ConfirmOptions) => (
    new Promise<boolean>((resolve) => {
      modal.confirm({
        title,
        content,
        okText,
        cancelText,
        okButtonProps: danger ? { danger: true } : undefined,
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    })
  ), [modal]);

  const confirmDanger = useCallback((title: string, content: ReactNode, okText = '确认操作') => (
    confirm({ title, content, okText, danger: true })
  ), [confirm]);

  const value = useMemo<FeedbackContextValue>(() => ({
    success,
    info,
    error,
    confirm,
    confirmDanger,
    refreshNotificationDuration,
  }), [confirm, confirmDanger, error, info, refreshNotificationDuration, success]);

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

/** 获取全站统一反馈服务。 */
export function useFeedback(): FeedbackContextValue {
  const context = useContext(FeedbackContext);
  if (!context) {
    throw new Error('useFeedback 必须在 FeedbackProvider 内使用');
  }
  return context;
}
