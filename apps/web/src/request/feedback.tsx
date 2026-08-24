import { App as AntApp } from 'antd';
import { createContext, useContext, type ReactNode } from 'react';
import { ApiError } from './http';

/** 通用确认弹窗参数（与 Ant Design modal.confirm 对齐，但只暴露业务常用字段）。 */
export interface ConfirmOptions {
  title: ReactNode;
  content?: ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}

/** 统一页面反馈接口（主 PRD §10.5）。 */
interface FeedbackContextValue {
  success: (content: string) => void;
  info: (content: string) => void;
  error: (error: unknown, fallback?: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmDanger: (title: string, content: ReactNode, okText?: string) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

/**
 * 全站 Ant Design 反馈服务。
 *
 * 所有提示均通过受控 React 文本节点传入 Ant Design；不会将服务端文案当作 HTML 渲染。
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { message, modal, notification } = AntApp.useApp();

  const value: FeedbackContextValue = {
    success(content) {
      void message.success(content);
    },
    info(content) {
      void message.info(content);
    },
    error(error, fallback = '操作失败，请稍后重试') {
      if (error instanceof ApiError) {
        if (error.type === 'SYSTEM') {
          notification.error({
            message: '系统处理失败',
            description: `请稍后重试。请求编号：${error.body.requestId}`,
          });
          return;
        }
        void message.error(error.body.message || fallback);
        return;
      }
      void message.error(fallback);
    },
    confirm({ title, content, okText = '确认', cancelText = '取消', danger = false }) {
      return new Promise<boolean>((resolve) => {
        modal.confirm({
          title,
          content,
          okText,
          cancelText,
          okButtonProps: danger ? { danger: true } : undefined,
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
    },
    confirmDanger(title, content, okText = '确认操作') {
      return this.confirm({ title, content, okText, danger: true });
    },
  };

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
