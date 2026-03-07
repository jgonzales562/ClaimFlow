import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ClaimExtractionResult } from "../apps/worker/src/extraction.ts";
import { prisma } from "../packages/db/src/index.ts";
import { maybeEnqueueClaimForProcessing } from "../apps/web/lib/claims/ingest.ts";
import {
  markClaimAsError,
  persistClaimExtractionOutcome,
} from "../apps/worker/src/claim-state.ts";

after(async () => {
  await prisma.$disconnect();
});

test("webhook enqueue transitions NEW claims to PROCESSING and records one event", async () => {
  const { organizationId, claimId, cleanup } = await createClaimFixture("NEW");
  const inboundMessageId = `inbound-${randomUUID()}`;
  const providerMessageId = `provider-${randomUUID()}`;
  const queueMessageId = `message-${randomUUID()}`;

  try {
    const queueResult = await maybeEnqueueClaimForProcessing(
      {
        organizationId,
        claimId,
        inboundMessageId,
        providerMessageId,
        shouldEnqueue: true,
      },
      {
        prismaClient: prisma,
        enqueueClaimIngestJobFn: async () => ({
          enqueued: true,
          queueUrl: "https://example.invalid/claims",
          messageId: queueMessageId,
        }),
      },
    );

    assert.equal(queueResult?.enqueued, true);

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          select: {
            payload: true,
          },
        },
      },
    });

    assert.equal(updatedClaim.status, "PROCESSING");
    assert.equal(updatedClaim.events.length, 1);
    assert.deepEqual(readPayloadRecord(updatedClaim.events[0]?.payload), {
      fromStatus: "NEW",
      toStatus: "PROCESSING",
      source: "webhook_enqueue",
      inboundMessageId,
      providerMessageId,
      queueMessageId,
    });
  } finally {
    await cleanup();
  }
});

test("webhook enqueue does not duplicate transitions for claims already processing", async () => {
  const { organizationId, claimId, cleanup } = await createClaimFixture("PROCESSING");

  try {
    const queueResult = await maybeEnqueueClaimForProcessing(
      {
        organizationId,
        claimId,
        inboundMessageId: `inbound-${randomUUID()}`,
        providerMessageId: `provider-${randomUUID()}`,
        shouldEnqueue: true,
      },
      {
        prismaClient: prisma,
        enqueueClaimIngestJobFn: async () => ({
          enqueued: true,
          queueUrl: "https://example.invalid/claims",
          messageId: `message-${randomUUID()}`,
        }),
      },
    );

    assert.equal(queueResult?.enqueued, true);

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
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

    assert.equal(updatedClaim.status, "PROCESSING");
    assert.equal(updatedClaim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("worker failure marks processing claims as ERROR and records failure metadata", async () => {
  const { organizationId, claimId, cleanup } = await createClaimFixture("PROCESSING");

  try {
    await markClaimAsError(prisma, {
      claimId,
      organizationId,
      reason: "forced test failure",
      retryable: false,
      receiveCount: 3,
      failureDisposition: "dropped_non_retryable",
    });

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          select: {
            payload: true,
          },
        },
      },
    });

    assert.equal(updatedClaim.status, "ERROR");
    assert.equal(updatedClaim.events.length, 1);
    assert.deepEqual(readPayloadRecord(updatedClaim.events[0]?.payload), {
      fromStatus: "PROCESSING",
      toStatus: "ERROR",
      source: "worker_failure",
      failureDisposition: "dropped_non_retryable",
      receiveCount: 3,
      retryable: false,
      reason: "forced test failure",
    });
  } finally {
    await cleanup();
  }
});

test("worker failure does not overwrite claims that already left PROCESSING", async () => {
  const { organizationId, claimId, cleanup } = await createClaimFixture("READY");

  try {
    await markClaimAsError(prisma, {
      claimId,
      organizationId,
      reason: "late failure should not win",
      retryable: true,
      receiveCount: 2,
      failureDisposition: "moved_to_dlq",
    });

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
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

    assert.equal(updatedClaim.status, "READY");
    assert.equal(updatedClaim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("worker failure does not overwrite newer processing attempts", async () => {
  const { organizationId, claimId, cleanup } = await createClaimFixture("PROCESSING", {
    processingAttempt: 2,
  });

  try {
    await markClaimAsError(prisma, {
      claimId,
      organizationId,
      processingAttempt: 1,
      reason: "stale attempt should not win",
      retryable: true,
      receiveCount: 2,
      failureDisposition: "moved_to_dlq",
    });

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        processingAttempt: true,
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

    assert.equal(updatedClaim.status, "PROCESSING");
    assert.equal(updatedClaim.processingAttempt, 2);
    assert.equal(updatedClaim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("worker failure does not overwrite when the processing lease token no longer matches", async () => {
  const { organizationId, claimId, cleanup } = await createClaimFixture("PROCESSING", {
    processingAttempt: 2,
    processingLeaseToken: "lease-current",
    processingLeaseClaimedAt: new Date("2026-03-07T12:00:00.000Z"),
  });

  try {
    await markClaimAsError(prisma, {
      claimId,
      organizationId,
      processingAttempt: 2,
      processingLeaseToken: "lease-stale",
      reason: "stale lease should not win",
      retryable: true,
      receiveCount: 2,
      failureDisposition: "moved_to_dlq",
    });

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        processingAttempt: true,
        processingLeaseToken: true,
        processingLeaseClaimedAt: true,
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

    assert.equal(updatedClaim.status, "PROCESSING");
    assert.equal(updatedClaim.processingAttempt, 2);
    assert.equal(updatedClaim.processingLeaseToken, "lease-current");
    assert.equal(updatedClaim.processingLeaseClaimedAt?.toISOString(), "2026-03-07T12:00:00.000Z");
    assert.equal(updatedClaim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("worker failure is idempotent for claims already in ERROR", async () => {
  const { organizationId, claimId, cleanup } = await createClaimFixture("ERROR");

  try {
    await markClaimAsError(prisma, {
      claimId,
      organizationId,
      reason: "should not duplicate",
      retryable: true,
      receiveCount: 2,
      failureDisposition: "moved_to_dlq",
    });

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
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

    assert.equal(updatedClaim.status, "ERROR");
    assert.equal(updatedClaim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("worker extraction promotes complete high-confidence claims to READY", async () => {
  const { organizationId, claimId, cleanup, inboundMessageId } = await createClaimFixture("PROCESSING");

  try {
    const nextStatus = await persistClaimExtractionOutcome(prisma, {
      claim: {
        id: claimId,
        organizationId,
        processingAttempt: 0,
        customerName: null,
        productName: null,
        serialNumber: null,
        purchaseDate: null,
        issueSummary: "Existing issue summary",
        retailer: null,
      },
      inboundMessageId,
      selectedExtraction: buildExtractionResult({
        customerName: "Ada Lovelace",
        productName: "Premium Blender",
        serialNumber: "SN-12345",
        purchaseDate: "2026-02-14",
        issueSummary: "Motor stopped spinning",
        retailer: "Target",
        warrantyStatus: "LIKELY_IN_WARRANTY",
        missingInfo: [],
        confidence: 0.97,
      }),
      primaryRawOutput: { provider: "primary" },
      secondaryRawOutput: null,
      extractionSource: "openai_direct",
      shouldAttemptTextract: false,
      usedTextractPass: false,
      textractMetadata: { attempted: false, reason: "not_triggered" },
      inboundTextChars: 420,
      extractionReadyConfidence: 0.85,
    });

    assert.equal(nextStatus, "READY");

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        customerName: true,
        productName: true,
        serialNumber: true,
        purchaseDate: true,
        issueSummary: true,
        retailer: true,
        warrantyStatus: true,
        missingInfo: true,
        extractions: {
          select: {
            provider: true,
            confidence: true,
            extraction: true,
            rawOutput: true,
          },
        },
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          select: {
            payload: true,
          },
        },
      },
    });

    assert.equal(updatedClaim.status, "READY");
    assert.equal(updatedClaim.customerName, "Ada Lovelace");
    assert.equal(updatedClaim.productName, "Premium Blender");
    assert.equal(updatedClaim.serialNumber, "SN-12345");
    assert.equal(updatedClaim.purchaseDate?.toISOString(), "2026-02-14T00:00:00.000Z");
    assert.equal(updatedClaim.issueSummary, "Motor stopped spinning");
    assert.equal(updatedClaim.retailer, "Target");
    assert.equal(updatedClaim.warrantyStatus, "LIKELY_IN_WARRANTY");
    assert.deepEqual(updatedClaim.missingInfo, []);
    assert.equal(updatedClaim.extractions.length, 1);
    assert.equal(updatedClaim.extractions[0]?.provider, "OPENAI");
    assert.equal(updatedClaim.extractions[0]?.confidence, 0.97);
    assert.deepEqual(readPayloadRecord(updatedClaim.extractions[0]?.rawOutput), {
      source: "openai_direct",
      fallbackAttempted: false,
      fallbackUsed: false,
      inboundTextChars: 420,
      primary: { provider: "primary" },
      textract: { attempted: false, reason: "not_triggered" },
      textractPass: null,
    });
    assert.equal(updatedClaim.events.length, 1);
    const eventPayload = readPayloadRecord(updatedClaim.events[0]?.payload);
    assert.equal(eventPayload.fromStatus, "PROCESSING");
    assert.equal(eventPayload.toStatus, "READY");
    assert.equal(eventPayload.source, "worker_extraction");
    assert.equal(eventPayload.confidence, 0.97);
    assert.equal(eventPayload.fallbackUsed, false);
    assert.equal(typeof eventPayload.extractionId, "string");
  } finally {
    await cleanup();
  }
});

test("worker extraction keeps prior values and lands in REVIEW_REQUIRED when data is incomplete", async () => {
  const existingPurchaseDate = new Date("2025-12-20T00:00:00.000Z");
  const {
    organizationId,
    claimId,
    cleanup,
    inboundMessageId,
  } = await createClaimFixture("PROCESSING", {
    customerName: "Existing Customer",
    productName: "Existing Product",
    serialNumber: "EXISTING-SERIAL",
    purchaseDate: existingPurchaseDate,
    issueSummary: "Existing summary",
    retailer: "Existing Retailer",
  });

  try {
    const nextStatus = await persistClaimExtractionOutcome(prisma, {
      claim: {
        id: claimId,
        organizationId,
        processingAttempt: 0,
        customerName: "Existing Customer",
        productName: "Existing Product",
        serialNumber: "EXISTING-SERIAL",
        purchaseDate: existingPurchaseDate,
        issueSummary: "Existing summary",
        retailer: "Existing Retailer",
      },
      inboundMessageId,
      selectedExtraction: buildExtractionResult({
        customerName: null,
        productName: "Updated Product",
        serialNumber: null,
        purchaseDate: null,
        issueSummary: null,
        retailer: null,
        warrantyStatus: "UNCLEAR",
        missingInfo: ["purchase_date", "retailer"],
        confidence: 0.64,
      }),
      primaryRawOutput: { provider: "primary-review" },
      secondaryRawOutput: { provider: "secondary-review" },
      extractionSource: "textract_fallback",
      shouldAttemptTextract: true,
      usedTextractPass: true,
      textractMetadata: { attempted: true, attachmentsProcessed: 1 },
      inboundTextChars: 180,
      extractionReadyConfidence: 0.85,
    });

    assert.equal(nextStatus, "REVIEW_REQUIRED");

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        customerName: true,
        productName: true,
        serialNumber: true,
        purchaseDate: true,
        issueSummary: true,
        retailer: true,
        warrantyStatus: true,
        missingInfo: true,
        extractions: {
          select: {
            rawOutput: true,
          },
        },
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          select: {
            payload: true,
          },
        },
      },
    });

    assert.equal(updatedClaim.status, "REVIEW_REQUIRED");
    assert.equal(updatedClaim.customerName, "Existing Customer");
    assert.equal(updatedClaim.productName, "Updated Product");
    assert.equal(updatedClaim.serialNumber, "EXISTING-SERIAL");
    assert.equal(updatedClaim.purchaseDate?.toISOString(), existingPurchaseDate.toISOString());
    assert.equal(updatedClaim.issueSummary, "Existing summary");
    assert.equal(updatedClaim.retailer, "Existing Retailer");
    assert.equal(updatedClaim.warrantyStatus, "UNCLEAR");
    assert.deepEqual(updatedClaim.missingInfo, ["purchase_date", "retailer"]);
    assert.deepEqual(readPayloadRecord(updatedClaim.extractions[0]?.rawOutput), {
      source: "textract_fallback",
      fallbackAttempted: true,
      fallbackUsed: true,
      inboundTextChars: 180,
      primary: { provider: "primary-review" },
      textract: { attempted: true, attachmentsProcessed: 1 },
      textractPass: { provider: "secondary-review" },
    });
    const eventPayload = readPayloadRecord(updatedClaim.events[0]?.payload);
    assert.equal(eventPayload.toStatus, "REVIEW_REQUIRED");
    assert.equal(eventPayload.fallbackUsed, true);
  } finally {
    await cleanup();
  }
});

test("worker extraction skips writes when the claim already left PROCESSING", async () => {
  const { organizationId, claimId, cleanup, inboundMessageId } = await createClaimFixture("READY", {
    issueSummary: "Existing issue summary",
  });

  try {
    const nextStatus = await persistClaimExtractionOutcome(prisma, {
      claim: {
        id: claimId,
        organizationId,
        processingAttempt: 0,
        customerName: null,
        productName: null,
        serialNumber: null,
        purchaseDate: null,
        issueSummary: "Existing issue summary",
        retailer: null,
      },
      inboundMessageId,
      selectedExtraction: buildExtractionResult({
        customerName: "Late Worker",
        productName: "Duplicate Blender",
        warrantyStatus: "LIKELY_IN_WARRANTY",
        missingInfo: [],
        confidence: 0.92,
      }),
      primaryRawOutput: { provider: "late-primary" },
      secondaryRawOutput: null,
      extractionSource: "openai_direct",
      shouldAttemptTextract: false,
      usedTextractPass: false,
      textractMetadata: { attempted: false, reason: "not_triggered" },
      inboundTextChars: 320,
      extractionReadyConfidence: 0.85,
    });

    assert.equal(nextStatus, "READY");

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        customerName: true,
        extractions: {
          select: {
            id: true,
          },
        },
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

    assert.equal(updatedClaim.status, "READY");
    assert.equal(updatedClaim.customerName, null);
    assert.equal(updatedClaim.extractions.length, 0);
    assert.equal(updatedClaim.events.length, 0);
  } finally {
    await cleanup();
  }
});

function readPayloadRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function buildExtractionResult(
  overrides: Partial<ClaimExtractionResult["extraction"]>,
): ClaimExtractionResult {
  return {
    provider: "OPENAI",
    model: "test-model",
    schemaVersion: 1,
    extraction: {
      customerName: null,
      productName: null,
      serialNumber: null,
      purchaseDate: null,
      issueSummary: null,
      retailer: null,
      warrantyStatus: "UNCLEAR",
      missingInfo: [],
      confidence: 0.5,
      reasoning: "integration test",
      ...overrides,
    },
    rawOutput: {
      source: "integration-test",
    },
  };
}

async function createClaimFixture(
  status: "NEW" | "PROCESSING" | "REVIEW_REQUIRED" | "READY" | "ERROR",
  claimOverrides: Partial<{
    customerName: string | null;
    productName: string | null;
    serialNumber: string | null;
    purchaseDate: Date | null;
    issueSummary: string | null;
    retailer: string | null;
    processingAttempt: number;
    processingLeaseToken: string | null;
    processingLeaseClaimedAt: Date | null;
  }> = {},
) {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Integration Test ${suffix}`,
      slug: `integration-test-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  const claim = await prisma.claim.create({
    data: {
      organizationId: organization.id,
      externalClaimId: `claim-${suffix}`,
      sourceEmail: `test-${suffix}@example.com`,
      status,
      customerName: claimOverrides.customerName,
      productName: claimOverrides.productName,
      serialNumber: claimOverrides.serialNumber,
      purchaseDate: claimOverrides.purchaseDate,
      issueSummary: claimOverrides.issueSummary ?? "Integration test claim",
      retailer: claimOverrides.retailer,
      processingAttempt: claimOverrides.processingAttempt ?? 0,
      processingLeaseToken: claimOverrides.processingLeaseToken ?? null,
      processingLeaseClaimedAt: claimOverrides.processingLeaseClaimedAt ?? null,
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
      rawPayload: { test: true },
      claimId: claim.id,
      subject: "Integration test inbound",
    },
  });

  return {
    organizationId: organization.id,
    claimId: claim.id,
    inboundMessageId: inboundMessage.id,
    cleanup: async () => {
      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });
    },
  };
}
