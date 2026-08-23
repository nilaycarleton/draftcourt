/**
 * A simple bounded-failure-count circuit breaker for wrapping calls to an
 * external dependency (the analytics service, a cache backend) that can go
 * down without taking DraftCourt down with it. After `failureThreshold`
 * consecutive failures the breaker "opens" and every call short-circuits
 * to `fallback()` for `resetAfterMs`, then allows one trial call
 * ("half-open") to decide whether to close again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly failureThreshold = 3,
    private readonly resetAfterMs = 30_000,
  ) {}

  get isOpen(): boolean {
    if (this.openedAt === null) return false;
    return Date.now() - this.openedAt < this.resetAfterMs;
  }

  async exec<T>(fn: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
    if (this.isOpen) return fallback();

    try {
      const result = await fn();
      this.failures = 0;
      this.openedAt = null;
      return result;
    } catch {
      this.failures += 1;
      if (this.failures >= this.failureThreshold) {
        this.openedAt = Date.now();
      }
      return fallback();
    }
  }

  /** Explicit state transitions for callers that don't use exceptions as
   * their failure signal (e.g. analytics-client's result unions) — same
   * bookkeeping `exec` does internally. */
  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
    }
  }
}
