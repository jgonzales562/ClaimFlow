import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  DatabaseFixedWindowRateLimiter,
  readClientIp,
} from "../apps/web/lib/security/rate-limit.ts";
import { prisma } from "../packages/db/src/index.ts";

after(async () => {
  await prisma.$disconnect();
});

test("database rate limiter shares counters through persistent storage", async () => {
  const key = `test-rate-limit-${randomUUID()}`;
  const firstLimiter = new DatabaseFixedWindowRateLimiter(prisma);
  const secondLimiter = new DatabaseFixedWindowRateLimiter(prisma);

  try {
    const first = await firstLimiter.check({
      key,
      limit: 2,
      windowMs: 60_000,
      now: new Date("2026-03-05T12:00:00.000Z"),
    });
    const second = await secondLimiter.check({
      key,
      limit: 2,
      windowMs: 60_000,
      now: new Date("2026-03-05T12:00:01.000Z"),
    });
    const third = await firstLimiter.check({
      key,
      limit: 2,
      windowMs: 60_000,
      now: new Date("2026-03-05T12:00:02.000Z"),
    });

    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    assert.equal(third.allowed, false);
  } finally {
    await prisma.rateLimitBucket.deleteMany({
      where: {
        key,
      },
    });
  }
});

test("client IP reader prefers trusted proxy headers before forwarded chains", () => {
  const request = new Request("https://example.test", {
    headers: {
      "cf-connecting-ip": "203.0.113.10",
      "x-real-ip": "203.0.113.11",
      "x-forwarded-for": "198.51.100.20, 198.51.100.21",
    },
  });

  assert.equal(readClientIp(request), "203.0.113.10");
});
