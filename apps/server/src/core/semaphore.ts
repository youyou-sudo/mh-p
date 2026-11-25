/**
 * 并发信号量（从 detect/detect.ts 搬出：Detector 已随 Xray 退役删除，但订阅同步与
 * 按需检测仍然需要"并发确实受限"这个能力，验收 AC-8 依赖它）。
 */
export class Semaphore {
  private queue: (() => void)[] = []
  private active = 0
  /** 观测到的最大并发（验收 AC-8 用：证明并发确实受限） */
  peak = 0
  constructor(private limit: number) {}

  get running(): number {
    return this.active
  }

  get capacity(): number {
    return this.limit
  }

  resetPeak(): void {
    this.peak = 0
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      if (this.active > this.peak) this.peak = this.active
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    if (this.active > this.peak) this.peak = this.active
  }

  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }

  setLimit(n: number): void {
    this.limit = Math.max(1, n)
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
