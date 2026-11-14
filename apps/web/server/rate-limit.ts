/**
 * In-memory sliding-window limiter, counted per process (like the upload limit). `take` records a hit and returns null when allowed or the
 * seconds to wait when the key is over its budget. The synchronous check-and-record cannot be raced by concurrent requests in one process.
 * The map is bounded: expired keys are dropped on every call and the oldest are evicted past `maxKeys`.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  constructor(max: number, windowMs: number, now: () => number = Date.now, maxKeys = 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  take(key: string): number | null {
    const t = this.now();
    this.prune(t);
    const list = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.max(1, Math.ceil((list[0]! + this.windowMs - t) / 1000));
    }
    list.push(t);
    this.hits.set(key, list);
    return null;
  }

  /** Records a hit without checking (used to count only failures). Returns the number of hits in the window. */
  record(key: string): number {
    const t = this.now();
    this.prune(t);
    const list = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    list.push(t);
    this.hits.set(key, list);
    return list.length;
  }

  /** Seconds to wait when the key is at its budget, else null. Does not record. */
  blockedFor(key: string): number | null {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    return list.length >= this.max ? Math.max(1, Math.ceil((list[0]! + this.windowMs - t) / 1000)) : null;
  }

  reset(key?: string) {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  private prune(t: number) {
    for (const [k, list] of this.hits) {
      if (list.length === 0 || t - list[list.length - 1]! >= this.windowMs) this.hits.delete(k);
    }
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}
