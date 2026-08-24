import { Popconfirm } from 'antd';
import type { ReactNode } from 'react';

interface ConfirmActionProps {
  title: ReactNode;
  description?: ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  children: ReactNode;
}

/**
 * 统一二次确认气泡：按钮/开关等触发元素外包一层 Popconfirm，
 * 不同业务只改文案与危险色，避免各页面重复书写确认框属性。
 */
export function ConfirmAction({
  title,
  description,
  okText = '确认',
  cancelText = '取消',
  danger = false,
  onConfirm,
  children,
}: ConfirmActionProps) {
  return (
    <Popconfirm
      title={title}
      description={description}
      okText={okText}
      cancelText={cancelText}
      okButtonProps={danger ? { danger: true } : undefined}
      onConfirm={onConfirm}
    >
      {children}
    </Popconfirm>
  );
}
