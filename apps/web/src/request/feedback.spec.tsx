import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notification: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    open: vi.fn(),
    destroy: vi.fn(),
  },
  modal: {
    confirm: vi.fn(),
    info: vi.fn(),
  },
  getRuntimeSettings: vi.fn(),
}));

vi.mock('antd', () => ({
  App: {
    useApp: () => ({ modal: mocks.modal, notification: mocks.notification }),
  },
  theme: {
    useToken: () => ({
      token: {
        colorSuccess: '#5F765A',
        colorError: '#995B52',
        colorInfo: '#6D6876',
        colorBgElevated: '#FBF8F4',
        colorBorderSecondary: '#DED8D0',
        borderRadiusLG: 10,
        boxShadowSecondary: '0 8px 24px rgb(0 0 0 / 12%)',
      },
    }),
  },
}));

vi.mock('./http', () => {
  class ApiError extends Error {
    constructor(
      readonly body: { type: string; code: string; message: string; requestId: string },
      readonly httpStatus: number,
    ) {
      super(body.message);
    }

    get type(): string {
      return this.body.type;
    }
  }

  return {
    ApiError,
    http: { get: mocks.getRuntimeSettings },
  };
});

import { FeedbackProvider, useFeedback } from './feedback';
import { ApiError } from './http';

function FeedbackActions() {
  const feedback = useFeedback();
  return <>
    <button type="button" onClick={() => feedback.success('资料已保存')}>成功通知</button>
    <button type="button" onClick={() => feedback.info('没有需要保存的修改')}>普通通知</button>
    <button type="button" onClick={() => feedback.error(new ApiError({ type: 'SYSTEM', code: 'INTERNAL_ERROR', message: '内部错误', requestId: 'req-001' }, 500))}>系统错误通知</button>
  </>;
}

describe('全局悬浮通知', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeSettings.mockResolvedValue({ notificationDurationSeconds: 12 });
  });

  it('读取后台时长后，以右侧可关闭的带进度卡片展示成功反馈', async () => {
    render(<FeedbackProvider><FeedbackActions /></FeedbackProvider>);
    await waitFor(() => expect(mocks.getRuntimeSettings).toHaveBeenCalledWith('/runtime-settings/notifications'));

    fireEvent.click(screen.getByRole('button', { name: '成功通知' }));

    expect(mocks.notification.success).toHaveBeenCalledWith(expect.objectContaining({
      title: '操作成功',
      description: '资料已保存',
      placement: 'topRight',
      duration: 12,
      showProgress: true,
      pauseOnHover: true,
      closable: true,
      role: 'status',
    }));
  });

  it('点击通知卡片会在居中弹窗中打开同一条通知详情', async () => {
    render(<FeedbackProvider><FeedbackActions /></FeedbackProvider>);
    await waitFor(() => expect(mocks.getRuntimeSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '普通通知' }));
    const options = mocks.notification.info.mock.calls[0]?.[0] as { onClick?: () => void };
    options.onClick?.();

    expect(mocks.modal.info).toHaveBeenCalledWith(expect.objectContaining({
      title: '提示',
      okText: '关闭',
    }));
  });

  it('系统异常不暴露内部消息，仅展示请求编号', async () => {
    render(<FeedbackProvider><FeedbackActions /></FeedbackProvider>);
    await waitFor(() => expect(mocks.getRuntimeSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '系统错误通知' }));

    expect(mocks.notification.error).toHaveBeenCalledWith(expect.objectContaining({
      title: '系统处理失败',
      description: '请稍后重试。请求编号：req-001',
      role: 'alert',
    }));
  });
});
