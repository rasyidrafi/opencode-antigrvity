type QueueOptions = {
  concurrency: number;
  retryDelayMs: number;
  onError?: (item: unknown, error: unknown) => void;
};

/** A small deduplicating queue for durable work that can be retried after a
 * process restart. The durable source of truth remains the caller's store. */
export class BoundedRetryQueue<T> {
  private readonly pending = new Map<T, number>();
  private readonly running = new Map<T, Promise<void>>();
  private readonly waiters = new Map<T, Array<() => void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly work: (item: T) => Promise<void>,
    private readonly options: QueueOptions,
  ) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new RangeError("Queue concurrency must be a positive integer");
    if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0) throw new RangeError("Queue retry delay must be non-negative");
  }

  enqueue(item: T): Promise<void> {
    if (this.closed) return Promise.resolve();
    const attempt = new Promise<void>(resolve => {
      const waiters = this.waiters.get(item) ?? [];
      waiters.push(resolve);
      this.waiters.set(item, waiters);
    });
    if (this.running.has(item)) return attempt;
    this.pending.set(item, Date.now());
    this.pump();
    return attempt;
  }

  async drain(): Promise<void> {
    await Promise.all(this.running.values());
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const waiters of this.waiters.values()) for (const resolve of waiters) resolve();
    this.waiters.clear();
  }

  private pump(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    while (this.running.size < this.options.concurrency) {
      const now = Date.now();
      const next = [...this.pending].find(([, due]) => due <= now);
      if (!next) break;
      const [item] = next;
      this.pending.delete(item);
      const job = Promise.resolve().then(() => this.work(item)).catch(error => {
        try { this.options.onError?.(item, error); } catch { /* A reporter cannot stop queue progress. */ }
        this.pending.set(item, Date.now() + this.options.retryDelayMs);
      }).finally(() => {
        this.running.delete(item);
        for (const resolve of this.waiters.get(item) ?? []) resolve();
        this.waiters.delete(item);
        this.pump();
      });
      this.running.set(item, job);
    }

    if (this.pending.size === 0 || this.running.size >= this.options.concurrency) return;
    const nextDue = Math.min(...this.pending.values());
    const delay = Math.max(0, nextDue - Date.now());
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, delay);
    this.timer.unref?.();
  }
}
