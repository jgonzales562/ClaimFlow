import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import type { WorkerConfig } from "../apps/worker/src/config.ts";
import { recoverStaleProcessingClaims } from "../apps/worker/src/processing-watchdog.ts";

after(async () => {
  await prisma.$disconnect();
});

test("processing watchdog re-enqueues stale claims and records an automatic recovery event", async () => {
  const now = new Date("2026-01-01T13:00:00.000Z");
  await normalizeAmbientProcessingClaims(now);
  const { claimId, organizationId, inboundMessageId, providerMessageId, updatedAt, cleanup } =
    await createWatchdogFixture({
      updatedAt: new Date("2026-01-01T12:00:00.000Z"),
    });

  const sentCommands: Array<Record<string, unknown>> = [];
  const loggedInfo: Array<{ event: string; context: Record<string, unknown> }> = [];

  try {
    const result = await recoverStaleProcessingClaims(
      {
        prismaClient: prisma,
        sqsClient: {
          send: async (command) => {
            sentCommands.push((command as { input: Record<string, unknown> }).input);
            return {
              MessageId: "aws-watchdog-message-1",
            };
          },
        },
        config: buildWorkerConfig(),
      },
      {
        nowFn: () => now,
        createQueueMessageIdFn: () => "watchdog-queue-1",
        createProcessingLeaseTokenFn: () => "lease-watchdog-1",
        logInfoFn: (event, context) => {
          loggedInfo.push({ event, context });
        },
      },
    );

    assert.deepEqual(result, {
      scannedCount: 1,
      recoveredCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
    assert.equal(sentCommands.length, 1);
    assert.equal(sentCommands[0]?.QueueUrl, "https://example.invalid/claims");
    assert.equal(sentCommands[0]?.DelaySeconds, 2);
    assert.deepEqual(JSON.parse(String(sentCommands[0]?.MessageBody)), {
      version: 3,
      claimId,
      organizationId,
      inboundMessageId,
      providerMessageId,
      enqueuedAt: now.toISOString(),
      processingAttempt: 1,
      processingLeaseToken: "lease-watchdog-1",
    });

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
    assert.equal(claim.events[0]?.actorUserId, null);
    assert.deepEqual(
      loggedInfo.map((entry) => entry.event),
      ["processing_watchdog_recovered", "processing_watchdog_completed"],
    );
    assert.deepEqual(loggedInfo[0]?.context, {
      claimId,
      organizationId,
      previousProcessingAttempt: 0,
      nextProcessingAttempt: 1,
      queueMessageId: "watchdog-queue-1",
      inboundMessageId,
      providerMessageId,
    });
    assert.deepEqual(readPayloadRecord(claim.events[0]?.payload), {
      fromStatus: "PROCESSING",
      toStatus: "PROCESSING",
      source: "watchdog_processing_recovery",
      queueMessageId: "watchdog-queue-1",
      inboundMessageId,
      providerMessageId,
      staleMinutes: 30,
      previousUpdatedAt: updatedAt.toISOString(),
    });
  } finally {
    await cleanup();
  }
});

test("processing watchdog leaves fresh processing claims alone", async () => {
  const now = new Date("2026-01-01T13:00:00.000Z");
  await normalizeAmbientProcessingClaims(now);
  const { claimId, updatedAt, cleanup } = await createWatchdogFixture({
    updatedAt: now,
  });

  let sendCalled = false;

  try {
    const result = await recoverStaleProcessingClaims(
      {
        prismaClient: prisma,
        sqsClient: {
          send: async () => {
            sendCalled = true;
            return {
              MessageId: "should-not-send",
            };
          },
        },
        config: buildWorkerConfig(),
      },
      {
        nowFn: () => now,
      },
    );

    assert.deepEqual(result, {
      scannedCount: 0,
      recoveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
    });
    assert.equal(sendCalled, false);

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

function buildWorkerConfig(): WorkerConfig {
  return {
    awsRegion: "us-west-2",
    queueUrl: "https://example.invalid/claims",
    dlqUrl: "https://example.invalid/claims-dlq",
    processingStaleMinutes: 30,
    processingWatchdogEnabled: true,
    processingWatchdogIntervalMs: 60_000,
    processingWatchdogBatchSize: 25,
    pollWaitSeconds: 20,
    visibilityTimeoutSeconds: undefined,
    maxMessages: 5,
    processingConcurrency: 1,
    maxReceiveCount: 5,
    idleDelayMs: 250,
    errorDelayMs: 2_000,
    openAiApiKey: null,
    extractionModel: "test-model",
    extractionReadyConfidence: 0.85,
    extractionMaxInputChars: 12_000,
    textractFallbackEnabled: true,
    textractFallbackConfidenceThreshold: 0.75,
    textractFallbackMissingInfoCount: 3,
    textractFallbackMinInboundChars: 120,
    textractMaxAttachments: 5,
    textractMaxTextChars: 30_000,
    sentryDsn: null,
    sentryEnvironment: "test",
    sentryTracesSampleRate: 0.1,
  };
}

function readPayloadRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

async function normalizeAmbientProcessingClaims(now: Date): Promise<void> {
  await prisma.claim.updateMany({
    where: {
      status: "PROCESSING",
    },
    data: {
      updatedAt: now,
    },
  });
}

async function createWatchdogFixture(input: { updatedAt: Date }) {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Watchdog Test ${suffix}`,
      slug: `watchdog-test-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  const claim = await prisma.claim.create({
    data: {
      organizationId: organization.id,
      externalClaimId: `watchdog-claim-${suffix}`,
      sourceEmail: `watchdog-${suffix}@example.com`,
      issueSummary: "Watchdog fixture",
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
      subject: "Watchdog fixture inbound",
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
    claimId: claim.id,
    organizationId: organization.id,
    inboundMessageId: inboundMessage.id,
    providerMessageId: inboundMessage.providerMessageId,
    updatedAt: updatedClaim.updatedAt,
    cleanup: async () => {
      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });
    },
  };
}
