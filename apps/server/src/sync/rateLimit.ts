/**
 * Token bucket: allows bursts up to `capacity`, refilled at `refillPerSecond`. Each connection
 * has one for messages and one for bytes, checked on every incoming message.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(amount = 1): boolean {
    const current = this.now();
    const elapsed = Math.max(0, current - this.last) / 1000;
    this.last = current;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }
}
