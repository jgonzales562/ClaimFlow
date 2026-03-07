import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import { retryErroredClaim } from "../apps/web/lib/claims/retry.ts";

after(async () => {
  await prisma.$disconnect();
});

test("retryErroredClaim re-enqueues retryable error claims and records manual retry transitions", async () => {
  const { organizationId, userId, claimId, inboundMessageId, providerMessageId, cleanup } =
    await createRetryFixture({
      retryable: true,
    });

  const enqueueCalls: Array<Record<string, unknown>> = [];

  try {
    const result = await retryErroredClaim(
      {
        organizationId,
        actorUserId: userId,
        claimId,
      },
      {
        prismaClient: prisma,
        enqueueClaimIngestJobFn: async (input) => {
          enqueueCalls.push(input as unknown as Record<string, unknown>);
          return {
            enqueued: true,
            queueUrl: "https://example.invalid/claims",
            messageId: "message-retry-1",
          };
        },
      },
    );

    assert.deepEqual(result, {
      kind: "retried",
      claimId,
    });

    assert.deepEqual(enqueueCalls, [
      {
        claimId,
        organizationId,
        inboundMessageId,
        providerMessageId,
        delaySeconds: 2,
      },
    ]);

    const claim = await prisma.claim.findUniqueOrThrow({
      where: {
        id: claimId,
      },
      select: {
        status: true,
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            actorUserId: true,
            payload: true,
          },
        },
      },
    });

    assert.equal(claim.status, "PROCESSING");
    assert.equal(claim.events.length, 2);
    assert.deepEqual(readPayloadRecord(claim.events[1]?.payload), {
      fromStatus: "ERROR",
      toStatus: "PROCESSING",
      source: "manual_retry",
      inboundMessageId,
      providerMessageId,
      queueMessageId: "message-retry-1",
    });
    assert.equal(claim.events[1]?.actorUserId, userId);
  } finally {
    await cleanup();
  }
});

test("retryErroredClaim rejects non-retryable failures without enqueuing", async () => {
  const { organizationId, userId, claimId, cleanup } = await createRetryFixture({
    retryable: false,
  });

  let enqueueCalled = false;

  try {
    const result = await retryErroredClaim(
      {
        organizationId,
        actorUserId: userId,
        claimId,
      },
      {
        prismaClient: prisma,
        enqueueClaimIngestJobFn: async () => {
          enqueueCalled = true;
          return {
            enqueued: true,
            queueUrl: "https://example.invalid/claims",
            messageId: "message-retry-should-not-run",
          };
        },
      },
    );

    assert.deepEqual(result, {
      kind: "retry_not_allowed",
    });
    assert.equal(enqueueCalled, false);

    const claim = await prisma.claim.findUniqueOrThrow({
      where: {
        id: claimId,
      },
      select: {
        status: true,
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          select: {
            id: true,
          },
        },
      },
    });

    assert.equal(claim.status, "ERROR");
    assert.equal(claim.events.length, 1);
  } finally {
    await cleanup();
  }
});

test("retryErroredClaim leaves claims in ERROR when the retry queue is not configured", async () => {
  const { organizationId, userId, claimId, cleanup } = await createRetryFixture({
    retryable: true,
  });

  try {
    const result = await retryErroredClaim(
      {
        organizationId,
        actorUserId: userId,
        claimId,
      },
      {
        prismaClient: prisma,
        enqueueClaimIngestJobFn: async () => ({
          enqueued: false,
          reason: "queue_not_configured",
        }),
      },
    );

    assert.deepEqual(result, {
      kind: "queue_not_configured",
    });

    const claim = await prisma.claim.findUniqueOrThrow({
      where: {
        id: claimId,
      },
      select: {
        status: true,
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          select: {
            id: true,
          },
        },
      },
    });

    assert.equal(claim.status, "ERROR");
    assert.equal(claim.events.length, 1);
  } finally {
    await cleanup();
  }
});

function readPayloadRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

async function createRetryFixture(input: { retryable: boolean }) {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      email: `dashboard-retry-${suffix}@example.com`,
    },
    select: {
      id: true,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Dashboard Retry ${suffix}`,
      slug: `dashboard-retry-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  const claim = await prisma.claim.create({
    data: {
      organizationId: organization.id,
      externalClaimId: `dashboard-retry-${suffix}`,
      sourceEmail: `claim-${suffix}@example.com`,
      issueSummary: "Retry fixture",
      status: "ERROR",
    },
    select: {
      id: true,
    },
  });

  const providerMessageId = `provider-${suffix}`;
  const inboundMessage = await prisma.inboundMessage.create({
    data: {
      organizationId: organization.id,
      provider: "POSTMARK",
      providerMessageId,
      rawPayload: { seeded: true },
      claimId: claim.id,
      subject: "Retry fixture inbound",
    },
    select: {
      id: true,
    },
  });

  await prisma.claimEvent.create({
    data: {
      organizationId: organization.id,
      claimId: claim.id,
      eventType: "STATUS_TRANSITION",
      payload: {
        fromStatus: "PROCESSING",
        toStatus: "ERROR",
        source: "worker_failure",
        reason: "Temporary extraction failure",
        retryable: input.retryable,
        receiveCount: 3,
        failureDisposition: "moved_to_dlq",
      },
    },
  });

  return {
    organizationId: organization.id,
    userId: user.id,
    claimId: claim.id,
    inboundMessageId: inboundMessage.id,
    providerMessageId,
    cleanup: async () => {
      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });
      await prisma.user.delete({
        where: {
          id: user.id,
        },
      });
    },
  };
}
