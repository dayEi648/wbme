import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { createServer, Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import {
  listenServerWithFallback,
  listenWithFallback,
  listenWithFallbackCore,
} from './listen-with-fallback';

/** 获取一个当前空闲的端口（listen(0) 由内核分配） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : NaN;
      server.close(() => resolve(port));
    });
  });
}

/** 占用指定端口，返回关闭函数 */
async function occupyPort(port: number): Promise<() => Promise<void>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
}

/** 简易测试应用（不注册任何路由，仅验证监听行为） */
@Module({})
class ProbeModule {}

describe('listenWithFallbackCore（端口顺延核心逻辑）', () => {
  it('端口空闲时直接返回首选端口', async () => {
    const port = await freePort();
    let listenedPort: number | undefined;
    const actual = await listenWithFallbackCore(port, async (p) => {
      listenedPort = p;
    });
    expect(actual).toBe(port);
    expect(listenedPort).toBe(port);
  });

  it('EADDRINUSE 时 +1 顺延并返回实际端口', async () => {
    const port = await freePort();
    const release = await occupyPort(port);
    const attempted: number[] = [];
    const actual = await listenWithFallbackCore(
      port,
      async (p) => {
        attempted.push(p);
        if (p === port) {
          throw Object.assign(new Error(`EADDRINUSE: ${p}`), { code: 'EADDRINUSE' });
        }
      },
      { warn: () => undefined },
    );
    await release();
    expect(attempted).toEqual([port, port + 1]);
    expect(actual).toBe(port + 1);
  });

  it('达到尝试上限时抛出最后一次 EADDRINUSE', async () => {
    const port = await freePort();
    const releaseA = await occupyPort(port);
    const releaseB = await occupyPort(port + 1);
    const warnings: string[] = [];
    await expect(
      listenWithFallbackCore(
        port,
        async (p) => {
          throw Object.assign(new Error(`EADDRINUSE: ${p}`), { code: 'EADDRINUSE' });
        },
        { maxAttempts: 2, warn: (m) => warnings.push(m) },
      ),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await releaseA();
    await releaseB();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`顺延尝试 ${port + 1}`);
  });

  it('非 EADDRINUSE 错误原样抛出且不重试', async () => {
    const port = await freePort();
    let calls = 0;
    await expect(
      listenWithFallbackCore(
        port,
        async () => {
          calls++;
          throw new Error('boom');
        },
        { warn: () => undefined },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('listenServerWithFallback（node:http Server）', () => {
  const servers: Server[] = [];

  afterAll(() => {
    for (const server of servers) {
      server.close();
    }
  });

  it('端口空闲时正常监听并返回端口', async () => {
    const port = await freePort();
    const server = createServer();
    servers.push(server);
    const actual = await listenServerWithFallback(server, port);
    expect(actual).toBe(port);
  });

  it('EADDRINUSE 时 +1 顺延并返回实际端口', async () => {
    const port = await freePort();
    const release = await occupyPort(port);
    // 最小处理器（否则裸 http server 无 request 监听器时 fetch 会挂起）
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    servers.push(server);
    const actual = await listenServerWithFallback(server, port, undefined, {
      warn: () => undefined,
    });
    await release();
    expect(actual).toBe(port + 1);
    // 顺延后的端口确实可访问
    const res = await fetch(`http://127.0.0.1:${actual}/`);
    expect(res.status).toBe(404);
  });
});

describe('listenWithFallback（NestJS 应用）', () => {
  it('端口空闲时正常监听并返回端口', async () => {
    const port = await freePort();
    const app = await NestFactory.create(ProbeModule);
    try {
      const actual = await listenWithFallback(app, port);
      expect(actual).toBe(port);
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('EADDRINUSE 时 +1 顺延并返回实际端口', async () => {
    const port = await freePort();
    const release = await occupyPort(port);
    const app = await NestFactory.create(ProbeModule);
    try {
      const actual = await listenWithFallback(app, port, { warn: () => undefined });
      expect(actual).toBe(port + 1);
    } finally {
      await app.close();
      await release();
    }
  });
});
