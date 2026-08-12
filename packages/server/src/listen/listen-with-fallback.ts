import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * 端口监听兜底顺延（开发环境友好）。
 *
 * 背景：开发端口被占用时若直接失败退出，体验很差；本工具在目标端口被占用
 * （EADDRINUSE）时自动 +1 顺延重试，直到成功或达到尝试上限，并把实际端口返回给调用方。
 *
 * 说明：
 * - 仅对 EADDRINUSE 顺延，其余监听错误原样抛出；
 * - 生产 compose 内网端口固定且显式注入，通常不会触发顺延，顺延行为不改变生产契约；
 * - 顺延存在极小概率竞态窗口（预检后到 listen 之间端口被抢），由调用方日志提示实际端口。
 */

/** 顺延尝试上限（含首次尝试；超出后抛出最后一次 EADDRINUSE 错误） */
const DEFAULT_MAX_ATTEMPTS = 20;

export interface ListenFallbackOptions {
  /** 尝试上限（含首次，默认 20） */
  maxAttempts?: number;
  /** 顺延告警输出（默认 console.warn） */
  warn?: (message: string) => void;
}

function isEaddrinuse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

function warnOfFallback(port: number, nextPort: number, attempt: number, maxAttempts: number, warn: (m: string) => void): void {
  warn(`[port-fallback] 端口 ${port} 被占用，顺延尝试 ${nextPort}（第 ${attempt + 1}/${maxAttempts} 次）`);
}

/**
 * 核心顺延逻辑：按序尝试端口，EADDRINUSE 时 +1 重试，直至成功或达到上限。
 *
 * @param preferredPort 首选端口（未被占用时直接使用）
 * @param tryListen 单端口监听原语（如 app.listen(port) / server.listen(port)）
 * @returns 实际成功监听的端口
 */
export async function listenWithFallbackCore(
  preferredPort: number,
  tryListen: (port: number) => Promise<void>,
  options: ListenFallbackOptions = {},
): Promise<number> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = preferredPort + attempt - 1;
    try {
      await tryListen(port);
      return port;
    } catch (error) {
      if (!isEaddrinuse(error)) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw error;
      }
      warnOfFallback(port, port + 1, attempt, maxAttempts, warn);
    }
  }
  // 循环必然 return 或 throw，此处不可达
  throw new Error('listenWithFallbackCore: 不可达分支');
}

/** NestJS 应用监听（EADDRINUSE 自动 +1 顺延），返回实际监听端口 */
export function listenWithFallback(
  app: INestApplication,
  preferredPort: number,
  options: ListenFallbackOptions = {},
): Promise<number> {
  return listenWithFallbackCore(preferredPort, (port) => app.listen(port), options);
}

/** 单次监听原语：once 监听 error/listening 并双向清理，避免 EADDRINUSE 崩溃进程 */
function listenOnce(server: Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** node:http Server 监听（如 worker 健康探针；EADDRINUSE 自动 +1 顺延），返回实际监听端口 */
export function listenServerWithFallback(
  server: Server,
  preferredPort: number,
  host?: string,
  options: ListenFallbackOptions = {},
): Promise<number> {
  return listenWithFallbackCore(preferredPort, (port) => listenOnce(server, port, host), options);
}
