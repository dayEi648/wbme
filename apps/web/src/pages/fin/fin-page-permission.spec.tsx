import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted((): { can: (permission: string) => boolean } => ({ can: () => false }));

vi.mock('../../components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../../components/JsonDetails', () => ({
  JsonDetails: () => <div>财务运行参数</div>,
}));

vi.mock('../../components/ResourcePage', () => ({
  ResourcePage: () => <div>财务字典</div>,
}));

vi.mock('../../request/feedback', () => ({
  useFeedback: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../request/session', () => ({
  useSession: () => ({ can: session.can }),
}));

vi.mock('../../request/http', () => ({
  http: {
    get: vi.fn(() => Promise.resolve({ data: [] })),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve({})),
  },
  download: vi.fn(),
  upload: vi.fn(),
}));

import { http } from '../../request/http';
import FinPage from './FinPage';

describe('FinPage 权限挂载', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.can = (permission) => permission === 'finance_config';
  });

  it('仅有财务配置权限时不请求利润分析接口', () => {
    render(
      <MemoryRouter initialEntries={['/fin/config']}>
        <FinPage />
      </MemoryRouter>,
    );

    expect(http.get).not.toHaveBeenCalled();
  });
});
