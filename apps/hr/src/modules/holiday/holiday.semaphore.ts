/**
 * 进程级计数信号量（hr PRD §3：按供应商公开限额设置进程级有界限流，
 * 不通过无意义轮询消耗免费额度）。仅外部 HTTP 请求占令牌；
 * 缓存命中与离线兜底不占令牌。
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param maxConcurrent 最大并发数（必须 >= 1）
   */
  constructor(private readonly maxConcurrent: number) {}

  /**
   * 获取一个令牌（当前满载时排队等待）。
   *
   * @returns 释放函数（使用完成后调用）
   */
  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}
