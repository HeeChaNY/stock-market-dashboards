export class RateLimiter {
  constructor(requestsPerSecond) {
    this.minimumGap = Math.ceil(1000 / requestsPerSecond);
    this.maximumGap = 220;
    this.nextAt = 0;
  }

  async wait() {
    const now = Date.now();
    const scheduled = Math.max(now, this.nextAt);
    this.nextAt = scheduled + this.minimumGap;
    const delay = scheduled - now;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  penalize() {
    this.minimumGap = Math.min(this.maximumGap, Math.ceil(this.minimumGap * 1.08 + 5));
    this.nextAt = Math.max(this.nextAt, Date.now() + this.minimumGap);
  }
}
