import { createHash } from "node:crypto";

export type RateLimitDecision =
  | {
      allowed: true;
      remaining: number;
      resetAt: Date;
    }
  | {
      allowed: false;
      retryAfterSeconds: number;
      resetAt: Date;
    };

export type RateLimitCheckInput = {
  key: string;
  limit: number;
  windowMs: number;
  now?: Date;
};

export type RateLimiter = {
  check(input: RateLimitCheckInput): Promise<RateLimitDecision>;
};

export class InMemorySlidingWindowRateLimiter implements RateLimiter {
  private readonly attempts = new Map<string, number[]>();

  async check(input: RateLimitCheckInput): Promise<RateLimitDecision> {
    const nowMs = input.now?.getTime() ?? Date.now();
    const windowStartMs = nowMs - input.windowMs;
    const recentAttempts = (this.attempts.get(input.key) ?? []).filter(
      (attemptMs) => attemptMs > windowStartMs,
    );

    if (recentAttempts.length >= input.limit) {
      this.attempts.set(input.key, recentAttempts);
      const oldestAttemptMs = recentAttempts[0] ?? nowMs;
      const resetAt = new Date(oldestAttemptMs + input.windowMs);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - nowMs) / 1_000)),
        resetAt,
      };
    }

    recentAttempts.push(nowMs);
    this.attempts.set(input.key, recentAttempts);
    return {
      allowed: true,
      remaining: Math.max(0, input.limit - recentAttempts.length),
      resetAt: new Date((recentAttempts[0] ?? nowMs) + input.windowMs),
    };
  }

  clear(): void {
    this.attempts.clear();
  }
}

export const defaultRateLimiter = new InMemorySlidingWindowRateLimiter();

export function readClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor?.trim()) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return (
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown"
  );
}

export function fingerprintRateLimitPart(value: string | null): string {
  return createHash("sha256")
    .update(value?.trim() || "missing")
    .digest("hex")
    .slice(0, 24);
}

export function appendRateLimitHeaders(headers: Headers, decision: RateLimitDecision): void {
  if (decision.allowed) {
    headers.set("x-ratelimit-remaining", String(decision.remaining));
    headers.set("x-ratelimit-reset", decision.resetAt.toISOString());
    return;
  }

  headers.set("retry-after", String(decision.retryAfterSeconds));
  headers.set("x-ratelimit-remaining", "0");
  headers.set("x-ratelimit-reset", decision.resetAt.toISOString());
}
