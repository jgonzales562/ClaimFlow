import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import { recoverStaleProcessingClaim } from "../apps/web/lib/claims/processing-recovery.ts";

after(async () => {
  await prisma.$disconnect();
});

test("recoverStaleProcessingClaim re-enqueues stale processing claims and records a recovery event", async () => {
  const now = new Date("2026-01-01T13:00:00.000Z");
  const {
    organizationId,
    userId,
    claimId,
    inboundMessageId,
    providerMessageId,
    updatedAt,
    cleanup,
  } =
    await createProcessingRecoveryFixture({
      updatedAt: new Date("2026-01-01T12:00:00.000Z"),
    });

  const enqueueCalls: Array<Record<string, unknown>> = [];

  try {
    const result = await recoverStaleProcessingClaim(
      {
        organizationId,
        actorUserId: userId,
        claimId,
      },
      {
        prismaClient: prisma,
        nowFn: () => now,
        staleMinutes: 30,
        resolveQueueUrlFn: () => "https://example.invalid/claims",
        createQueueMessageIdFn: () => "queue-recovery-1",
        createProcessingLeaseTokenFn: () => "lease-recovery-1",
        enqueueClaimIngestJobFn: async (input) => {
          enqueueCalls.push(input as unknown as Record<string, unknown>);
          return {
            enqueued: true,
            queueUrl: "https://example.invalid/claims",
            messageId: "processing-recovery-message-1",
          };
        },
      },
    );

    assert.deepEqual(result, {
      kind: "recovered",
      claimId,
    });

    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0]?.claimId, claimId);
    assert.equal(enqueueCalls[0]?.organizationId, organizationId);
    assert.equal(enqueueCalls[0]?.inboundMessageId, inboundMessageId);
    assert.equal(enqueueCalls[0]?.providerMessageId, providerMessageId);
    assert.equal(enqueueCalls[0]?.processingAttempt, 1);
    assert.equal(enqueueCalls[0]?.processingLeaseToken, "lease-recovery-1");
    assert.equal(enqueueCalls[0]?.delaySeconds, 2);
    assert.equal(enqueueCalls[0]?.messageId, "queue-recovery-1");
    assert.equal(enqueueCalls[0]?.queueUrl, "https://example.invalid/claims");
    assert.ok(enqueueCalls[0]?.enqueuedAt instanceof Date);

    const claim = await prisma.claim.findUniqueOrThrow({
      where: {
        id: claimId,
      },
      select: {
        status: true,
        processingAttempt: true,
        updatedAt: true,
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          select: {
            actorUserId: true,
            payload: true,
          },
        },
      },
    });

    assert.equal(claim.status, "PROCESSING");
    assert.equal(claim.processingAttempt, 1);
    assert.equal(claim.updatedAt.toISOString(), now.toISOString());
    assert.equal(claim.events.length, 1);
    assert.equal(claim.events[0]?.actorUserId, userId);
    assert.deepEqual(readPayloadRecord(claim.events[0]?.payload), {
      fromStatus: "PROCESSING",
      toStatus: "PROCESSING",
      source: "manual_processing_recovery",
      queueMessageId: "queue-recovery-1",
      inboundMessageId,
      providerMessageId,
      staleMinutes: 30,
      previousUpdatedAt: updatedAt.toISOString(),
    });
  } finally {
    await cleanup();
  }
});

test("recoverStaleProcessingClaim rejects fresh processing claims without enqueuing", async () => {
  const now = new Date("2026-01-01T13:00:00.000Z");
  const { organizationId, userId, claimId, updatedAt, cleanup } =
    await createProcessingRecoveryFixture({
      updatedAt: new Date("2026-01-01T12:55:00.000Z"),
    });

  let enqueueCalled = false;

  try {
    const result = await recoverStaleProcessingClaim(
      {
        organizationId,
        actorUserId: userId,
        claimId,
      },
      {
        prismaClient: prisma,
        nowFn: () => now,
        staleMinutes: 30,
        enqueueClaimIngestJobFn: async () => {
          enqueueCalled = true;
          return {
            enqueued: true,
            queueUrl: "https://example.invalid/claims",
            messageId: "should-not-enqueue",
          };
        },
      },
    );

    assert.deepEqual(result, {
      kind: "recovery_not_allowed",
    });
    assert.equal(enqueueCalled, false);

    const claim = await prisma.claim.findUniqueOrThrow({
      where: {
        id: claimId,
      },
      select: {
        status: true,
        updatedAt: true,
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

    assert.equal(claim.status, "PROCESSING");
    assert.equal(claim.updatedAt.toISOString(), updatedAt.toISOString());
    assert.equal(claim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("recoverStaleProcessingClaim leaves stale claims untouched when the queue is not configured", async () => {
  const now = new Date("2026-01-01T13:00:00.000Z");
  const { organizationId, userId, claimId, updatedAt, cleanup } =
    await createProcessingRecoveryFixture({
      updatedAt: new Date("2026-01-01T12:00:00.000Z"),
    });

  try {
    const result = await recoverStaleProcessingClaim(
      {
        organizationId,
        actorUserId: userId,
        claimId,
      },
      {
        prismaClient: prisma,
        nowFn: () => now,
        staleMinutes: 30,
        resolveQueueUrlFn: () => null,
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
        updatedAt: true,
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

    assert.equal(claim.status, "PROCESSING");
    assert.equal(claim.updatedAt.toISOString(), updatedAt.toISOString());
    assert.equal(claim.events.length, 0);
  } finally {
    await cleanup();
  }
});

function readPayloadRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

async function createProcessingRecoveryFixture(input: { updatedAt: Date }) {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      email: `processing-recovery-${suffix}@example.com`,
    },
    select: {
      id: true,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Processing Recovery ${suffix}`,
      slug: `processing-recovery-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  const claim = await prisma.claim.create({
    data: {
      organizationId: organization.id,
      externalClaimId: `processing-recovery-${suffix}`,
      sourceEmail: `claim-${suffix}@example.com`,
      issueSummary: "Stale processing fixture",
      status: "PROCESSING",
    },
    select: {
      id: true,
    },
  });

  const inboundMessage = await prisma.inboundMessage.create({
    data: {
      organizationId: organization.id,
      provider: "POSTMARK",
      providerMessageId: `provider-${suffix}`,
      rawPayload: { seeded: true },
      claimId: claim.id,
      subject: "Processing recovery fixture",
    },
    select: {
      id: true,
      providerMessageId: true,
    },
  });

  const updatedClaim = await prisma.claim.update({
    where: {
      id: claim.id,
    },
    data: {
      updatedAt: input.updatedAt,
    },
    select: {
      updatedAt: true,
    },
  });

  return {
    organizationId: organization.id,
    userId: user.id,
    claimId: claim.id,
    inboundMessageId: inboundMessage.id,
    providerMessageId: inboundMessage.providerMessageId,
    updatedAt: updatedClaim.updatedAt,
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
