import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { ClaimStatus } from "@prisma/client";
import type { PersistClaimExtractionOutcomeInput } from "../apps/worker/src/claim-state.ts";
import type { ClaimExtractionResult } from "../apps/worker/src/extraction.ts";
import {
  processClaimIngestJob,
  type ClaimIngestJobConfig,
} from "../apps/worker/src/ingest-job.ts";
import type { ClaimIngestQueueMessage } from "../apps/worker/src/queue-handler.ts";
import { prisma } from "../packages/db/src/index.ts";

const TEST_CONFIG: ClaimIngestJobConfig = {
  awsRegion: "us-west-2",
  openAiApiKey: null,
  extractionModel: "test-model",
  extractionReadyConfidence: 0.85,
  extractionMaxInputChars: 12_000,
  textractFallbackEnabled: false,
  textractFallbackConfidenceThreshold: 0.75,
  textractFallbackMissingInfoCount: 3,
  textractFallbackMinInboundChars: 120,
  textractMaxAttachments: 5,
  textractMaxTextChars: 30_000,
};

after(async () => {
  await prisma.$disconnect();
});

test("worker ingest job fails closed when the inbound message is missing", async () => {
  const { organizationId, claimId, cleanup } = await createClaimFixture("PROCESSING");

  try {
    await assert.rejects(
      () =>
        processClaimIngestJob(prisma, TEST_CONFIG, {
          ...buildQueueMessage({ organizationId, claimId }),
          inboundMessageId: "missing-inbound-message",
        }),
      (error: unknown) => {
        assert.equal((error as Error & { retryable?: unknown }).retryable, false);
        assert.match(String((error as Error).message), /was not found/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("worker ingest job fails closed when an inbound message has no claim", async () => {
  const { organizationId, claimId, inboundMessageId, cleanup } = await createClaimFixture("PROCESSING", {
    inboundMessageHasClaim: false,
  });

  try {
    await assert.rejects(
      () =>
        processClaimIngestJob(prisma, TEST_CONFIG, {
          ...buildQueueMessage({ organizationId, claimId }),
          inboundMessageId,
        }),
      (error: unknown) => {
        assert.equal((error as Error & { retryable?: unknown }).retryable, false);
        assert.match(String((error as Error).message), /was not found for ingest processing/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("worker ingest job fails closed when the queue message claim does not match the inbound message claim", async () => {
  const { organizationId, inboundMessageId, cleanup } = await createClaimFixture("PROCESSING");
  const mismatchedClaim = await prisma.claim.create({
    data: {
      organizationId,
      externalClaimId: `claim-mismatch-${randomUUID()}`,
      sourceEmail: "mismatch@example.com",
      issueSummary: "Mismatch claim",
      status: "NEW",
    },
    select: {
      id: true,
    },
  });

  try {
    await assert.rejects(
      () =>
        processClaimIngestJob(prisma, TEST_CONFIG, {
          ...buildQueueMessage({ organizationId, claimId: mismatchedClaim.id }),
          inboundMessageId,
        }),
      (error: unknown) => {
        assert.equal((error as Error & { retryable?: unknown }).retryable, false);
        assert.match(String((error as Error).message), /does not belong to claim/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("worker ingest job fails closed when the queue message organization does not match the claim", async () => {
  const { claimId, inboundMessageId, cleanup } = await createClaimFixture("PROCESSING");

  try {
    await assert.rejects(
      () =>
        processClaimIngestJob(prisma, TEST_CONFIG, {
          ...buildQueueMessage({
            organizationId: "org-does-not-match",
            claimId,
          }),
          inboundMessageId,
        }),
      (error: unknown) => {
        assert.equal((error as Error & { retryable?: unknown }).retryable, false);
        assert.match(String((error as Error).message), /does not belong to organization/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("worker ingest job skips extraction for terminal claim statuses", async () => {
  const { organizationId, claimId, inboundMessageId, cleanup } = await createClaimFixture("READY");
  let extractionCalls = 0;
  let persistCalls = 0;

  try {
    await processClaimIngestJob(
      prisma,
      TEST_CONFIG,
      {
        ...buildQueueMessage({ organizationId, claimId, inboundMessageId }),
      },
      {
        extractClaimDataFn: async () => {
          extractionCalls += 1;
          throw new Error("extractClaimData should not run for READY claims");
        },
        persistClaimExtractionOutcomeFn: async () => {
          persistCalls += 1;
          return "READY";
        },
      },
    );

    const claim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        events: {
          where: { eventType: "STATUS_TRANSITION" },
          select: { id: true },
        },
      },
    });

    assert.equal(extractionCalls, 0);
    assert.equal(persistCalls, 0);
    assert.equal(claim.status, "READY");
    assert.equal(claim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("worker ingest job ignores stale version 2 attempts once a newer attempt exists", async () => {
  const { organizationId, claimId, inboundMessageId, cleanup } = await createClaimFixture(
    "PROCESSING",
    {
      processingAttempt: 2,
    },
  );
  let extractionCalls = 0;

  try {
    await processClaimIngestJob(
      prisma,
      TEST_CONFIG,
      buildQueueMessage({
        version: 2,
        processingAttempt: 1,
        organizationId,
        claimId,
        inboundMessageId,
      }),
      {
        extractClaimDataFn: async () => {
          extractionCalls += 1;
          return buildExtractionResult();
        },
        persistClaimExtractionOutcomeFn: async () => {
          throw new Error("stale attempts should not persist extraction results");
        },
      },
    );

    const claim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        processingAttempt: true,
        events: {
          where: { eventType: "STATUS_TRANSITION" },
          select: { id: true },
        },
      },
    });

    assert.equal(extractionCalls, 0);
    assert.equal(claim.status, "PROCESSING");
    assert.equal(claim.processingAttempt, 2);
    assert.equal(claim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("worker ingest job retries version 2 attempts that arrive before the claim advance is recorded", async () => {
  const { organizationId, claimId, inboundMessageId, cleanup } = await createClaimFixture("ERROR");
  let extractionCalls = 0;

  try {
    await assert.rejects(
      () =>
        processClaimIngestJob(
          prisma,
          TEST_CONFIG,
          buildQueueMessage({
            version: 2,
            processingAttempt: 1,
            organizationId,
            claimId,
            inboundMessageId,
          }),
          {
            extractClaimDataFn: async () => {
              extractionCalls += 1;
              return buildExtractionResult();
            },
          },
        ),
      (error: unknown) => {
        assert.equal((error as Error & { retryable?: unknown }).retryable, true);
        assert.match(String((error as Error).message), /not ready for processing attempt 1/);
        return true;
      },
    );

    const claim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        processingAttempt: true,
        events: {
          where: { eventType: "STATUS_TRANSITION" },
          select: { id: true },
        },
      },
    });

    assert.equal(extractionCalls, 0);
    assert.equal(claim.status, "ERROR");
    assert.equal(claim.processingAttempt, 0);
    assert.equal(claim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("worker ingest job ignores version 3 messages when the lease is already claimed", async () => {
  const { organizationId, claimId, inboundMessageId, cleanup } = await createClaimFixture(
    "PROCESSING",
    {
      processingAttempt: 3,
      processingLeaseToken: "lease-current",
      processingLeaseClaimedAt: new Date("2026-03-07T12:00:00.000Z"),
    },
  );
  let extractionCalls = 0;

  try {
    await processClaimIngestJob(
      prisma,
      TEST_CONFIG,
      buildQueueMessage({
        version: 3,
        processingAttempt: 3,
        processingLeaseToken: "lease-current",
        organizationId,
        claimId,
        inboundMessageId,
      }),
      {
        extractClaimDataFn: async () => {
          extractionCalls += 1;
          return buildExtractionResult();
        },
        persistClaimExtractionOutcomeFn: async () => {
          throw new Error("claimed leases should not run extraction twice");
        },
      },
    );

    const claim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        processingAttempt: true,
        processingLeaseToken: true,
        processingLeaseClaimedAt: true,
        events: {
          where: { eventType: "STATUS_TRANSITION" },
          select: { id: true },
        },
      },
    });

    assert.equal(extractionCalls, 0);
    assert.equal(claim.status, "PROCESSING");
    assert.equal(claim.processingAttempt, 3);
    assert.equal(claim.processingLeaseToken, "lease-current");
    assert.equal(claim.processingLeaseClaimedAt?.toISOString(), "2026-03-07T12:00:00.000Z");
    assert.equal(claim.events.length, 0);
  } finally {
    await cleanup();
  }
});

test("worker ingest job transitions NEW claims into PROCESSING before extraction", async () => {
  const { organizationId, claimId, inboundMessageId, providerMessageId, cleanup } = await createClaimFixture("NEW");
  let extractionCalls = 0;

  try {
    await processClaimIngestJob(
      prisma,
      TEST_CONFIG,
      buildQueueMessage({ organizationId, claimId, inboundMessageId, providerMessageId }),
      {
        extractClaimDataFn: async () => {
          extractionCalls += 1;
          return buildExtractionResult();
        },
        persistClaimExtractionOutcomeFn: async () => "REVIEW_REQUIRED",
      },
    );

    const claim = await prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        events: {
          where: { eventType: "STATUS_TRANSITION" },
          select: { payload: true },
        },
      },
    });

    assert.equal(extractionCalls, 1);
    assert.equal(claim.status, "PROCESSING");
    assert.equal(claim.events.length, 1);
    assert.deepEqual(readPayloadRecord(claim.events[0]?.payload), {
      fromStatus: "NEW",
      toStatus: "PROCESSING",
      source: "worker_ingest_start",
      inboundMessageId,
      providerMessageId,
    });
  } finally {
    await cleanup();
  }
});

test("worker ingest job uses the textract pass when it produces a better extraction", async () => {
  const {
    organizationId,
    claimId,
    inboundMessageId,
    providerMessageId,
    cleanup,
  } = await createClaimFixture("PROCESSING", {
    textBody: "short inbound body",
  });
  const textractConfig: ClaimIngestJobConfig = {
    ...TEST_CONFIG,
    textractFallbackEnabled: true,
  };
  const extractionCalls: Array<{ supplementalText: string | null }> = [];
  const textractCalls: Array<{ attachmentCount: number; region: string }> = [];
  const persistedInputs: PersistClaimExtractionOutcomeInput[] = [];
  const primaryExtraction = buildExtractionResult({
    provider: "OPENAI",
    extraction: {
      confidence: 0.41,
      issueSummary: "Primary extraction",
      missingInfo: ["serial_number", "purchase_date", "retailer"],
    },
    rawOutput: { stage: "primary" },
  });
  const secondaryExtraction = buildExtractionResult({
    provider: "OPENAI",
    extraction: {
      confidence: 0.94,
      customerName: "Taylor",
      productName: "Washer",
      serialNumber: "SN-42",
      issueSummary: "Secondary extraction",
      missingInfo: [],
    },
    rawOutput: { stage: "secondary" },
  });

  try {
    await createStoredAttachment({ organizationId, claimId, inboundMessageId });

    await processClaimIngestJob(
      prisma,
      textractConfig,
      buildQueueMessage({ organizationId, claimId, inboundMessageId, providerMessageId }),
      {
        extractClaimDataFn: async (input) => {
          extractionCalls.push({ supplementalText: input.supplementalText });
          return extractionCalls.length === 1 ? primaryExtraction : secondaryExtraction;
        },
        extractAttachmentTextWithTextractFn: async (input) => {
          textractCalls.push({
            attachmentCount: input.attachments.length,
            region: input.region,
          });
          return {
            attempted: true,
            provider: "aws_textract",
            attachmentsProcessed: input.attachments.length,
            text: "attachment derived text",
          };
        },
        persistClaimExtractionOutcomeFn: async (_prismaClient, input) => {
          persistedInputs.push(input);
          return "READY";
        },
      },
    );

    assert.deepEqual(extractionCalls, [
      { supplementalText: null },
      { supplementalText: "attachment derived text" },
    ]);
    assert.deepEqual(textractCalls, [{ attachmentCount: 1, region: "us-west-2" }]);
    assert.equal(persistedInputs.length, 1);
    assert.equal(persistedInputs[0]?.shouldAttemptTextract, true);
    assert.equal(persistedInputs[0]?.usedTextractPass, true);
    assert.equal(persistedInputs[0]?.selectedExtraction, secondaryExtraction);
    assert.equal(persistedInputs[0]?.extractionSource, "textract_fallback");
    assert.deepEqual(persistedInputs[0]?.secondaryRawOutput, { stage: "secondary" });
    assert.deepEqual(persistedInputs[0]?.textractMetadata, {
      attempted: true,
      provider: "aws_textract",
      attachmentsProcessed: 1,
      text: "attachment derived text",
    });
  } finally {
    await cleanup();
  }
});

test("worker ingest job skips textract when fallback thresholds are not met", async () => {
  const {
    organizationId,
    claimId,
    inboundMessageId,
    providerMessageId,
    cleanup,
  } = await createClaimFixture("PROCESSING", {
    textBody:
      "This inbound body is intentionally long enough to stay above the textract fallback minimum character threshold for the worker path.",
  });
  const textractConfig: ClaimIngestJobConfig = {
    ...TEST_CONFIG,
    textractFallbackEnabled: true,
  };
  let textractCalled = false;
  const persistedInputs: PersistClaimExtractionOutcomeInput[] = [];
  const primaryExtraction = buildExtractionResult({
    provider: "OPENAI",
    extraction: {
      confidence: 0.97,
      customerName: "Jordan",
      productName: "Dryer",
      serialNumber: "SN-100",
      issueSummary: "Primary extraction high confidence",
      missingInfo: [],
    },
    rawOutput: { stage: "primary-no-fallback" },
  });

  try {
    await createStoredAttachment({ organizationId, claimId, inboundMessageId });

    await processClaimIngestJob(
      prisma,
      textractConfig,
      buildQueueMessage({ organizationId, claimId, inboundMessageId, providerMessageId }),
      {
        extractClaimDataFn: async () => primaryExtraction,
        extractAttachmentTextWithTextractFn: async () => {
          textractCalled = true;
          throw new Error("textract should not run when thresholds are not met");
        },
        persistClaimExtractionOutcomeFn: async (_prismaClient, input) => {
          persistedInputs.push(input);
          return "READY";
        },
      },
    );

    assert.equal(textractCalled, false);
    assert.equal(persistedInputs.length, 1);
    assert.equal(persistedInputs[0]?.shouldAttemptTextract, false);
    assert.equal(persistedInputs[0]?.usedTextractPass, false);
    assert.equal(persistedInputs[0]?.selectedExtraction, primaryExtraction);
    assert.equal(persistedInputs[0]?.extractionSource, "openai_direct");
    assert.deepEqual(persistedInputs[0]?.textractMetadata, {
      attempted: false,
      reason: "quality_threshold_not_met",
      attachmentsAvailable: 1,
      inboundTextChars:
        "Worker ingest job inbound".length +
        "This inbound body is intentionally long enough to stay above the textract fallback minimum character threshold for the worker path."
          .length,
    });
  } finally {
    await cleanup();
  }
});

test("worker ingest job keeps the primary extraction when the textract pass is lower quality", async () => {
  const {
    organizationId,
    claimId,
    inboundMessageId,
    providerMessageId,
    cleanup,
  } = await createClaimFixture("PROCESSING", {
    textBody: "short inbound body",
  });
  const textractConfig: ClaimIngestJobConfig = {
    ...TEST_CONFIG,
    textractFallbackEnabled: true,
  };
  const persistedInputs: PersistClaimExtractionOutcomeInput[] = [];
  const primaryExtraction = buildExtractionResult({
    provider: "OPENAI",
    extraction: {
      confidence: 0.78,
      customerName: "Morgan",
      productName: "Oven",
      serialNumber: "SN-500",
      issueSummary: "Primary wins",
      missingInfo: [],
    },
    rawOutput: { stage: "primary-better" },
  });
  const secondaryExtraction = buildExtractionResult({
    provider: "OPENAI",
    extraction: {
      confidence: 0.52,
      issueSummary: "Secondary worse",
      missingInfo: ["customer_name", "serial_number", "retailer"],
    },
    rawOutput: { stage: "secondary-worse" },
  });
  let extractionCalls = 0;

  try {
    await createStoredAttachment({ organizationId, claimId, inboundMessageId });

    await processClaimIngestJob(
      prisma,
      textractConfig,
      buildQueueMessage({ organizationId, claimId, inboundMessageId, providerMessageId }),
      {
        extractClaimDataFn: async () => {
          extractionCalls += 1;
          return extractionCalls === 1 ? primaryExtraction : secondaryExtraction;
        },
        extractAttachmentTextWithTextractFn: async () => ({
          attempted: true,
          provider: "aws_textract",
          attachmentsProcessed: 1,
          text: "secondary text",
        }),
        persistClaimExtractionOutcomeFn: async (_prismaClient, input) => {
          persistedInputs.push(input);
          return "REVIEW_REQUIRED";
        },
      },
    );

    assert.equal(extractionCalls, 2);
    assert.equal(persistedInputs.length, 1);
    assert.equal(persistedInputs[0]?.selectedExtraction, primaryExtraction);
    assert.equal(persistedInputs[0]?.usedTextractPass, false);
    assert.equal(persistedInputs[0]?.extractionSource, "openai_direct");
    assert.deepEqual(persistedInputs[0]?.secondaryRawOutput, { stage: "secondary-worse" });
  } finally {
    await cleanup();
  }
});

test("worker ingest job logs textract re-extraction failures and keeps the primary extraction", async () => {
  const {
    organizationId,
    claimId,
    inboundMessageId,
    providerMessageId,
    cleanup,
  } = await createClaimFixture("PROCESSING", {
    textBody: "short inbound body",
  });
  const textractConfig: ClaimIngestJobConfig = {
    ...TEST_CONFIG,
    textractFallbackEnabled: true,
  };
  const persistedInputs: PersistClaimExtractionOutcomeInput[] = [];
  const loggedErrors: Array<{ event: string; context: Record<string, unknown> }> = [];
  const primaryExtraction = buildExtractionResult({
    provider: "OPENAI",
    extraction: {
      confidence: 0.44,
      issueSummary: "Primary after failed textract retry",
      missingInfo: ["serial_number", "purchase_date", "retailer"],
    },
    rawOutput: { stage: "primary-after-error" },
  });
  let extractionCalls = 0;

  try {
    await createStoredAttachment({ organizationId, claimId, inboundMessageId });

    await processClaimIngestJob(
      prisma,
      textractConfig,
      buildQueueMessage({ organizationId, claimId, inboundMessageId, providerMessageId }),
      {
        extractClaimDataFn: async () => {
          extractionCalls += 1;
          if (extractionCalls === 1) {
            return primaryExtraction;
          }

          throw new Error("secondary extraction failed");
        },
        extractAttachmentTextWithTextractFn: async () => ({
          attempted: true,
          provider: "aws_textract",
          attachmentsProcessed: 1,
          text: "secondary text",
        }),
        persistClaimExtractionOutcomeFn: async (_prismaClient, input) => {
          persistedInputs.push(input);
          return "REVIEW_REQUIRED";
        },
        logErrorFn: (event, context) => {
          loggedErrors.push({ event, context });
        },
      },
    );

    assert.equal(extractionCalls, 2);
    assert.equal(persistedInputs.length, 1);
    assert.equal(persistedInputs[0]?.selectedExtraction, primaryExtraction);
    assert.equal(persistedInputs[0]?.usedTextractPass, false);
    assert.equal(persistedInputs[0]?.secondaryRawOutput, null);
    assert.deepEqual(loggedErrors, [
      {
        event: "textract_reextraction_failed",
        context: {
          claimId,
          inboundMessageId,
          error: "secondary extraction failed",
        },
      },
    ]);
  } finally {
    await cleanup();
  }
});

function readPayloadRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function buildQueueMessage(overrides: Partial<ClaimIngestQueueMessage>): ClaimIngestQueueMessage {
  if (
    overrides.version === 3 ||
    (typeof overrides.processingAttempt === "number" &&
      typeof overrides.processingLeaseToken === "string")
  ) {
    return {
      version: 3,
      claimId: overrides.claimId ?? "claim-default",
      organizationId: overrides.organizationId ?? "org-default",
      inboundMessageId: overrides.inboundMessageId ?? "inbound-default",
      providerMessageId: overrides.providerMessageId ?? "provider-default",
      enqueuedAt: overrides.enqueuedAt ?? "2026-03-05T12:00:00.000Z",
      processingAttempt: overrides.processingAttempt ?? 1,
      processingLeaseToken: overrides.processingLeaseToken ?? "lease-default",
    };
  }

  if (overrides.version === 2 || typeof overrides.processingAttempt === "number") {
    return {
      version: 2,
      claimId: overrides.claimId ?? "claim-default",
      organizationId: overrides.organizationId ?? "org-default",
      inboundMessageId: overrides.inboundMessageId ?? "inbound-default",
      providerMessageId: overrides.providerMessageId ?? "provider-default",
      enqueuedAt: overrides.enqueuedAt ?? "2026-03-05T12:00:00.000Z",
      processingAttempt: overrides.processingAttempt ?? 1,
    };
  }

  return {
    version: 1,
    claimId: overrides.claimId ?? "claim-default",
    organizationId: overrides.organizationId ?? "org-default",
    inboundMessageId: overrides.inboundMessageId ?? "inbound-default",
    providerMessageId: overrides.providerMessageId ?? "provider-default",
    enqueuedAt: overrides.enqueuedAt ?? "2026-03-05T12:00:00.000Z",
  };
}

function buildExtractionResult(
  overrides: Partial<ClaimExtractionResult> & {
    extraction?: Partial<ClaimExtractionResult["extraction"]>;
  } = {},
): ClaimExtractionResult {
  return {
    provider: overrides.provider ?? "FALLBACK",
    model: overrides.model ?? "fallback-local-heuristic-v1",
    schemaVersion: overrides.schemaVersion ?? 1,
    extraction: {
      customerName: null,
      productName: null,
      serialNumber: null,
      purchaseDate: null,
      issueSummary: "Fallback issue summary",
      retailer: null,
      warrantyStatus: "UNCLEAR",
      missingInfo: ["customer_name"],
      confidence: 0.35,
      reasoning: "test extraction",
      ...overrides.extraction,
    },
    rawOutput: overrides.rawOutput ?? {
      source: "worker-ingest-job-test",
    },
  };
}

async function createClaimFixture(
  status: ClaimStatus,
  options: {
    inboundMessageHasClaim?: boolean;
    subject?: string | null;
    textBody?: string | null;
    strippedTextReply?: string | null;
    processingAttempt?: number;
    processingLeaseToken?: string | null;
    processingLeaseClaimedAt?: Date | null;
  } = {},
) {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Worker Ingest Job ${suffix}`,
      slug: `worker-ingest-job-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  const claim = await prisma.claim.create({
    data: {
      organizationId: organization.id,
      externalClaimId: `claim-${suffix}`,
      sourceEmail: `worker-${suffix}@example.com`,
      status,
      processingAttempt: options.processingAttempt ?? 0,
      processingLeaseToken: options.processingLeaseToken ?? null,
      processingLeaseClaimedAt: options.processingLeaseClaimedAt ?? null,
      issueSummary: "Worker ingest job fixture",
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
      rawPayload: { test: true },
      claimId: options.inboundMessageHasClaim === false ? null : claim.id,
      subject: options.subject ?? "Worker ingest job inbound",
      textBody: options.textBody ?? null,
      strippedTextReply: options.strippedTextReply ?? null,
    },
    select: {
      id: true,
    },
  });

  return {
    organizationId: organization.id,
    claimId: claim.id,
    inboundMessageId: inboundMessage.id,
    providerMessageId,
    cleanup: async () => {
      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });
    },
  };
}

async function createStoredAttachment(input: {
  organizationId: string;
  claimId: string;
  inboundMessageId: string;
}): Promise<void> {
  await prisma.claimAttachment.create({
    data: {
      organizationId: input.organizationId,
      claimId: input.claimId,
      inboundMessageId: input.inboundMessageId,
      originalFilename: "receipt.pdf",
      contentType: "application/pdf",
      byteSize: 128,
      s3Bucket: "test-bucket",
      s3Key: `test/${randomUUID()}/receipt.pdf`,
    },
  });
}
