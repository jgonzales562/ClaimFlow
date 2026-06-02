import { createHash } from "node:crypto";
import { prisma } from "@claimflow/db";
import { Prisma, type PrismaClient } from "@prisma/client";

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

export class DatabaseFixedWindowRateLimiter implements RateLimiter {
  constructor(private readonly prismaClient: PrismaClient = prisma) {}

  async check(input: RateLimitCheckInput): Promise<RateLimitDecision> {
    const now = input.now ?? new Date();
    const windowExpiredBefore = new Date(now.getTime() - input.windowMs);
    const resetAt = new Date(now.getTime() + input.windowMs);

    const rows = await this.prismaClient.$queryRaw<
      Array<{ count: number; windowStartAt: Date; expiresAt: Date }>
    >(Prisma.sql`
      INSERT INTO "RateLimitBucket" (
        "key",
        "count",
        "windowStartAt",
        "expiresAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${input.key},
        1,
        ${now},
        ${resetAt},
        ${now},
        ${now}
      )
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitBucket"."windowStartAt" <= ${windowExpiredBefore}
            THEN 1
          ELSE "RateLimitBucket"."count" + 1
        END,
        "windowStartAt" = CASE
          WHEN "RateLimitBucket"."windowStartAt" <= ${windowExpiredBefore}
            THEN ${now}
          ELSE "RateLimitBucket"."windowStartAt"
        END,
        "expiresAt" = CASE
          WHEN "RateLimitBucket"."windowStartAt" <= ${windowExpiredBefore}
            THEN ${resetAt}
          ELSE "RateLimitBucket"."expiresAt"
        END,
        "updatedAt" = ${now}
      RETURNING "count", "windowStartAt", "expiresAt"
    `);

    const row = rows[0];
    if (!row) {
      throw new Error("Rate limit check did not return a bucket row.");
    }

    if (row.count > input.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1_000),
        ),
        resetAt: row.expiresAt,
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, input.limit - row.count),
      resetAt: row.expiresAt,
    };
  }
}

export const defaultRateLimiter = createDefaultRateLimiter();

function createDefaultRateLimiter(): RateLimiter {
  const storageMode = process.env.CLAIMFLOW_RATE_LIMIT_STORAGE?.trim().toLowerCase();
  if (storageMode === "memory") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CLAIMFLOW_RATE_LIMIT_STORAGE=memory is not allowed in production.");
    }

    return new InMemorySlidingWindowRateLimiter();
  }

  if (storageMode && storageMode !== "database") {
    throw new Error("CLAIMFLOW_RATE_LIMIT_STORAGE must be database or memory.");
  }

  if (!storageMode && (process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT))) {
    return new InMemorySlidingWindowRateLimiter();
  }

  return new DatabaseFixedWindowRateLimiter();
}

export function readClientIp(request: Request): string {
  const cloudflareIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflareIp) {
    return cloudflareIp;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor?.trim()) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return "unknown";
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
