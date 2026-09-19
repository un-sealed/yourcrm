/**
 * In-memory sliding-window rate limiter for login attempts (Wave-1).
 * Keyed per IP and per account, as required by spec 04. Process-local:
 * sufficient for single-instance dev/self-host; a Redis-backed limiter
 * replaces this when the worker/HA story lands (no caller changes — the
 * `consume` shape is the contract).
 */

export type RateLimitOptions = {
  /** Max attempts per key per window. Defaults: 10/account, 30/IP. */
  maxAttempts?: number
  /** Window length in ms. Default: 10 minutes. */
  windowMs?: number
}

type Bucket = { count: number; resetAt: number }

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly maxAttempts: number
  private readonly windowMs: number

  constructor(options: RateLimitOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 10
    this.windowMs = options.windowMs ?? 10 * 60 * 1000
  }

  /** True when the key may attempt; records the attempt when `record` is set. */
  isAllowed(key: string, now = Date.now(), record = true): boolean {
    const bucket = this.buckets.get(key)
    if (!bucket || now >= bucket.resetAt) {
      if (record) this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (bucket.count >= this.maxAttempts) return false
    if (record) bucket.count += 1
    return true
  }

  /** Clear a key (e.g. after a successful login resets the account counter). */
  reset(key: string): void {
    this.buckets.delete(key)
  }

  /** Test/dev helper: drop all counters. */
  clear(): void {
    this.buckets.clear()
  }
}

/** Default limiter instances: distinct budgets for IPs vs accounts. */
export function createLoginRateLimiters() {
  return {
    perIp: new LoginRateLimiter({ maxAttempts: 30 }),
    perAccount: new LoginRateLimiter({ maxAttempts: 10 }),
  }
}

export type LoginRateLimiters = ReturnType<typeof createLoginRateLimiters>
