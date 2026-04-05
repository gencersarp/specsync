/**
 * Token bucket rate limiter for API calls.
 * Used to prevent hitting GitHub and Notion API rate limits.
 */

export interface RateLimiterConfig {
  /** Maximum number of tokens in the bucket */
  maxTokens: number;
  /** Tokens added per second */
  refillRate: number;
  /** Optional name for logging */
  name?: string;
}

export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private lastRefill: number;
  private readonly name: string;

  constructor(config: RateLimiterConfig) {
    this.maxTokens = config.maxTokens;
    this.refillRate = config.refillRate;
    this.tokens = config.maxTokens;
    this.lastRefill = Date.now();
    this.name = config.name ?? "default";
  }

  /**
   * Refill tokens based on elapsed time since last refill.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /**
   * Acquire a token, waiting if necessary.
   * Returns a promise that resolves when a token is available.
   */
  async acquire(cost: number = 1): Promise<void> {
    this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return;
    }

    // Calculate wait time until enough tokens are available
    const deficit = cost - this.tokens;
    const waitMs = (deficit / this.refillRate) * 1000;

    await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(waitMs)));

    this.refill();
    this.tokens -= cost;
  }

  /**
   * Try to acquire a token without waiting.
   * Returns true if successful, false if no tokens available.
   */
  tryAcquire(cost: number = 1): boolean {
    this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }

    return false;
  }

  /**
   * Get current available tokens (after refill).
   */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Get the limiter name.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Reset the bucket to full capacity and reset the refill clock.
   * Useful in tests to restore a known state between cases.
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}

// Pre-configured limiters for GitHub and Notion APIs

/**
 * GitHub API rate limit: 5000 requests/hour for authenticated apps.
 * We use 80 tokens max, refilling at ~1.3/sec (conservative).
 */
export function createGitHubRateLimiter(): RateLimiter {
  return new RateLimiter({
    maxTokens: 80,
    refillRate: 1.3,
    name: "github",
  });
}

/**
 * Notion API rate limit: 3 requests/second average.
 * We use 3 tokens max, refilling at 2.5/sec (conservative).
 */
export function createNotionRateLimiter(): RateLimiter {
  return new RateLimiter({
    maxTokens: 3,
    refillRate: 2.5,
    name: "notion",
  });
}

/**
 * Wraps an async function with rate limiting.
 */
export function withRateLimit<T extends unknown[], R>(
  limiter: RateLimiter,
  fn: (...args: T) => Promise<R>
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    await limiter.acquire();
    return fn(...args);
  };
}
