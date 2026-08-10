import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildExportBuffer } from './export-builder';
import { parseImportBuffer } from './import-parser';

/**
 * 有界 CPU 工作线程池（主 PRD §9.1 / fin PRD §4）。
 *
 * - 承载利润分析 Excel 解析与工作簿序列化等可能长时间占用 CPU 的步骤，
 *   不阻塞 NestJS 主事件循环；工作池只承载当前请求的计算；
 * - 固定 2 个工作线程（资源有界）；任务排队执行；
 * - 取消/超时：排队中的任务直接丢弃；正在执行的任务 terminate 该 worker 并重建
 *   （尽快终止并释放内存）；worker 异常退出时自动替换。
 */
/** 工作池固定线程数（资源有界；主 PRD §9.1 有界 CPU 工作池） */
const POOL_SIZE = 2;

@Injectable()
export class XlsxWorkerPool implements OnModuleDestroy {
  /**
   * 内联模式（测试用）：不创建真实工作线程，直接在调用线程执行解析/构建。
   * 生产与 OpenAPI 生成保持线程模式；集成测试（vitest 无 dist worker 产物）置 true。
   */
  static inline = false;
  private readonly workers: Worker[] = [];
  private readonly busy: Set<Worker> = new Set();
  /** 正在终止的 worker（terminate 完成前不参与派发——dispatch 跳过，防任务派给垂死 worker 挂起） */
  private readonly terminating: Set<Worker> = new Set();
  /** worker → 当前执行任务（worker 异常/退出时兜底 reject） */
  private readonly pendingTasks = new Map<Worker, TaskEntry | null>();
  private readonly queue: TaskEntry[] = [];
  private nextId = 0;
  private stopped = false;

  // 注意：构造函数不得声明可注入参数（无参构造使 design:paramtypes 为空，
  // 避免 Nest DI 把默认参数类型误当依赖 token）
  constructor() {
    for (let i = 0; i < POOL_SIZE; i++) {
      this.workers.push(this.spawn());
    }
  }

  /** 创建工作线程（worker 入口编译进 dist/modules/excel/xlsx-worker.js） */
  private spawn(): Worker {
    const worker = new Worker(resolve(__dirname, 'xlsx-worker.js'));
    worker.on('message', (message: { id: string; ok: boolean; result?: unknown; error?: { message: string } }) => {
      // 任务完成：以 this.pendingTasks 跟踪（此前用闭包内从未写入的 pending Map，
      // task 恒 undefined 导致正常完成路径永不 resolve——生产线程模式导入/导出挂起，
      // 仅测试 inline 模式掩盖了该缺陷；S7 复核修复）
      const task = this.pendingTasks.get(worker);
      this.pendingTasks.set(worker, null);
      this.busy.delete(worker);
      if (task) {
        if (message.ok) {
          task.resolve(message.result);
        } else {
          task.reject(new Error(message.error?.message ?? 'Excel 工作线程执行失败'));
        }
      }
      this.dispatch();
    });
    worker.on('error', (error) => {
      // worker 异常：其任务 reject，替换新 worker（任务不可恢复，由请求层决定重试/失败）
      const task = this.pendingTasks.get(worker);
      this.pendingTasks.set(worker, null);
      this.busy.delete(worker);
      if (task) {
        task.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (!this.stopped) {
        const index = this.workers.indexOf(worker);
        if (index >= 0) {
          this.workers[index] = this.spawn();
          // 替换后重新派发：否则队列中的任务要等下一次触发才接手（worker 崩溃且队列非空时停滞）
          this.dispatch();
        }
      }
    });
    worker.on('exit', () => {
      this.busy.delete(worker);
    });
    this.pendingTasks.set(worker, null);
    return worker;
  }

  /**
   * 提交任务到工作池。
   *
   * @param kind 任务类型
   * @param payload 任务负载（结构化可序列化）
   * @param transfer 需要转移的 ArrayBuffer（可选）
   * @param signal 取消信号（排队任务丢弃；执行中任务 terminate 重建）
   * @returns 任务结果
   */
  async run<T>(
    kind: 'parse' | 'build',
    payload: unknown,
    transfer: ArrayBuffer[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.stopped) {
      throw new Error('Excel 工作池已关闭');
    }
    if (signal?.aborted) {
      throw new Error('任务已取消');
    }
    if (XlsxWorkerPool.inline) {
      // 内联模式：与工作线程相同的纯函数执行（等价语义，仅无线程隔离）
      if (kind === 'parse') {
        return parseImportBuffer(Buffer.from((payload as { buffer: ArrayBuffer }).buffer)) as unknown as T;
      }
      return buildExportBuffer((payload as { groups: Parameters<typeof buildExportBuffer>[0] }).groups) as unknown as T;
    }
    const task = new TaskEntry(`task-${this.nextId++}`, kind, payload, transfer);
    this.queue.push(task);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          const index = this.queue.indexOf(task);
          if (index >= 0) {
            this.queue.splice(index, 1);
            task.reject(new Error('任务已取消'));
            return;
          }
          // 正在执行：reject 任务（调用方立即收到取消，避免挂到路由超时）并 terminate 对应 worker 重建（尽快释放内存）
          for (const [worker, current] of this.pendingTasks) {
            if (current === task) {
              this.pendingTasks.set(worker, null);
              this.busy.delete(worker);
              // 标记终止中：terminate 完成前 dispatch 不把新任务派给该 worker
              // （垂死 worker 的 postMessage 消息会被丢弃，任务 Promise 挂起——S7 复核修复）
              this.terminating.add(worker);
              task.reject(new Error('任务已取消'));
              void worker.terminate().then(() => {
                this.terminating.delete(worker);
                if (!this.stopped) {
                  const index = this.workers.indexOf(worker);
                  if (index >= 0) {
                    this.workers[index] = this.spawn();
                  }
                  this.dispatch();
                }
              });
              break;
            }
          }
        },
        { once: true },
      );
    }
    this.dispatch();
    return task.promise as Promise<T>;
  }

  /** 派发队列任务到空闲 worker */
  private dispatch(): void {
    if (this.stopped) {
      return;
    }
    for (const worker of this.workers) {
      if (this.busy.has(worker) || this.terminating.has(worker)) {
        continue;
      }
      let task: TaskEntry | undefined;
      while (this.queue.length > 0) {
        const candidate = this.queue.shift();
        if (candidate && !candidate.settled) {
          task = candidate;
          break;
        }
      }
      if (!task) {
        return;
      }
      this.busy.add(worker);
      this.pendingTasks.set(worker, task);
      worker.postMessage({ id: task.id, kind: task.kind, payload: task.payload }, task.transfer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const task of this.queue.splice(0)) {
      task.reject(new Error('Excel 工作池已关闭'));
    }
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}

/** 排队/执行中的任务条目 */
class TaskEntry {
  readonly promise: Promise<unknown>;
  settled = false;

  constructor(
    readonly id: string,
    readonly kind: 'parse' | 'build',
    readonly payload: unknown,
    readonly transfer: ArrayBuffer[],
  ) {
    this.promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      this.resolve = (value: unknown) => {
        if (!this.settled) {
          this.settled = true;
          resolvePromise(value);
        }
      };
      this.reject = (reason: Error) => {
        if (!this.settled) {
          this.settled = true;
          rejectPromise(reason);
        }
      };
    });
  }

  resolve!: (value: unknown) => void;
  reject!: (reason: Error) => void;
}
