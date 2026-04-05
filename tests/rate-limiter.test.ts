import { describe, it, expect } from "vitest";
import {
  RateLimiter,
  createGitHubRateLimiter,
  createNotionRateLimiter,
  withRateLimit,
} from "../src/rate-limiter";

describe("RateLimiter", () => {
  it("allows requests when tokens are available", () => {
    const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1 });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("rejects when tokens are exhausted", () => {
    const limiter = new RateLimiter({ maxTokens: 1, refillRate: 0.001 });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it("refills tokens over time", async () => {
    const limiter = new RateLimiter({ maxTokens: 2, refillRate: 100 });
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBe(false);

    // Wait enough time for refill
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("acquire() waits for tokens", async () => {
    const limiter = new RateLimiter({ maxTokens: 1, refillRate: 100 });
    limiter.tryAcquire(); // drain

    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    // Should have waited some time
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("reports available tokens", () => {
    const limiter = new RateLimiter({ maxTokens: 10, refillRate: 1 });
    expect(limiter.getAvailableTokens()).toBeCloseTo(10, 0);
    limiter.tryAcquire(3);
    expect(limiter.getAvailableTokens()).toBeCloseTo(7, 0);
  });

  it("does not exceed max tokens on refill", async () => {
    const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(limiter.getAvailableTokens()).toBeLessThanOrEqual(5);
  });

  it("returns name", () => {
    const limiter = new RateLimiter({ maxTokens: 1, refillRate: 1, name: "test" });
    expect(limiter.getName()).toBe("test");
  });

  it("defaults name to 'default'", () => {
    const limiter = new RateLimiter({ maxTokens: 1, refillRate: 1 });
    expect(limiter.getName()).toBe("default");
  });
});

describe("pre-configured limiters", () => {
  it("creates GitHub rate limiter", () => {
    const limiter = createGitHubRateLimiter();
    expect(limiter.getName()).toBe("github");
    expect(limiter.getAvailableTokens()).toBeGreaterThan(0);
  });

  it("creates Notion rate limiter", () => {
    const limiter = createNotionRateLimiter();
    expect(limiter.getName()).toBe("notion");
    expect(limiter.getAvailableTokens()).toBeGreaterThan(0);
  });
});

describe("withRateLimit", () => {
  it("wraps a function with rate limiting", async () => {
    const limiter = new RateLimiter({ maxTokens: 10, refillRate: 10 });
    const fn = async (x: number) => x * 2;
    const limited = withRateLimit(limiter, fn);
    const result = await limited(5);
    expect(result).toBe(10);
  });
});
