import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostmarkInboundHandler } from "../apps/web/lib/postmark/inbound-webhook.ts";
import { maybeEnqueueClaimForProcessing } from "../apps/web/lib/claims/ingest.ts";
import {
  markClaimAsError,
  releaseClaimProcessingLease,
} from "../apps/worker/src/claim-state.ts";
import type { ClaimExtractionResult } from "../apps/worker/src/extraction.ts";
import {
  processClaimIngestJob,
  type ClaimIngestJobConfig,
} from "../apps/worker/src/ingest-job.ts";
import {
  handleClaimQueueMessage,
  type ClaimIngestQueueMessage,
} from "../apps/worker/src/queue-handler.ts";
import { prisma } from "../packages/db/src/index.ts";

after(async () => {
  await prisma.$disconnect();
});

test("full pipeline smoke processes a webhook claim through queue handling into READY", async () => {
  const suffix = randomUUID();
  const mailboxHash = `mailbox-${suffix}`;
  const providerMessageId = `message-${suffix}`;
  const authHeader = `Basic ${Buffer.from("smoke-user:smoke-pass").toString("base64")}`;
  let capturedQueueMessage: ClaimIngestQueueMessage | null = null;
  const queueTransport = createQueueTransportRecorder();

  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "smoke-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "smoke-pass",
    },
    async () => {
      const organization = await prisma.organization.create({
        data: {
          name: `Pipeline Smoke ${suffix}`,
          slug: `pipeline-smoke-${suffix}`,
          integrationMailbox: {
            create: {
              provider: "POSTMARK",
              mailboxHash,
              emailAddress: `claims+${suffix}@example.com`,
            },
          },
        },
        select: {
          id: true,
        },
      });

      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
        maybeEnqueueClaimForProcessingFn: (input) =>
          maybeEnqueueClaimForProcessing(input, {
            prismaClient: prisma,
            enqueueClaimIngestJobFn: async (queueInput) => {
              capturedQueueMessage = buildEnqueuedQueueMessage(
                queueInput,
                "2026-03-06T12:00:00.000Z",
              );

              return {
                enqueued: true,
                queueUrl: "https://example.invalid/claims",
                messageId: `sqs-${suffix}`,
              };
            },
          }),
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: providerMessageId,
              MailboxHash: mailboxHash,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Warranty request for blender",
              TextBody:
                "Customer Ada Lovelace reports the Premium Blender stopped spinning after purchase. Serial SN-12345 from Target on 2026-02-14.",
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 200);

        const body = (await response.json()) as Record<string, unknown>;
        const claimId = body.claimId as string;
        const inboundMessageId = body.messageId as string;

        assert.equal(body.ok, true);
        assert.equal(body.deduplicated, false);
        assert.equal(body.claimStatus, "PROCESSING");
        assert.deepEqual(body.attachments, {
          received: 0,
          stored: 0,
          failed: 0,
          errors: [],
        });
        assert.deepEqual(body.queue, {
          enqueued: true,
          queueUrl: "https://example.invalid/claims",
          messageId: `sqs-${suffix}`,
        });

        assert.notEqual(capturedQueueMessage, null);
        assert.equal(capturedQueueMessage?.version, 3);
        assert.equal(capturedQueueMessage?.processingAttempt, 1);
        assert.equal(typeof capturedQueueMessage?.processingLeaseToken, "string");
        assert.equal(capturedQueueMessage?.claimId, claimId);
        assert.equal(capturedQueueMessage?.organizationId, organization.id);
        assert.equal(capturedQueueMessage?.inboundMessageId, inboundMessageId);
        assert.equal(capturedQueueMessage?.providerMessageId, providerMessageId);

        const config = {
          queueUrl: "https://example.invalid/claims",
          dlqUrl: null,
          maxReceiveCount: 3,
          awsRegion: "us-west-2",
          openAiApiKey: null,
          extractionModel: "test-model",
          extractionReadyConfidence: 0.85,
          extractionMaxInputChars: 8_000,
          textractFallbackEnabled: false,
          textractFallbackConfidenceThreshold: 0.75,
          textractFallbackMissingInfoCount: 2,
          textractFallbackMinInboundChars: 250,
          textractMaxAttachments: 3,
          textractMaxTextChars: 12_000,
        } satisfies ClaimIngestJobConfig & {
          queueUrl: string;
          dlqUrl: null;
          maxReceiveCount: number;
        };

        await handleClaimQueueMessage(
          {
            config,
            sqsClient: queueTransport.sqsClient,
            sqsMessage: {
              MessageId: `sqs-${suffix}`,
              ReceiptHandle: `receipt-${suffix}`,
              Body: JSON.stringify(capturedQueueMessage),
              Attributes: {
                ApproximateReceiveCount: "1",
              },
            },
          },
          {
            processClaimIngestJobFn: (jobConfig, queueMessage) =>
              processClaimIngestJob(prisma, jobConfig, queueMessage, {
                extractClaimDataFn: async () => buildReadyExtraction(),
              }),
            markClaimAsErrorFn: (input) => markClaimAsError(prisma, input),
            releaseClaimProcessingLeaseFn: (input) => releaseClaimProcessingLease(prisma, input),
            logInfoFn: () => {},
            logErrorFn: () => {},
          },
        );

        assert.deepEqual(queueTransport.deletedReceiptHandles, [`receipt-${suffix}`]);
        assert.equal(queueTransport.sentMessages.length, 0);

        const claim = await prisma.claim.findUniqueOrThrow({
          where: { id: claimId },
          select: {
            status: true,
            processingLeaseToken: true,
            processingLeaseClaimedAt: true,
            customerName: true,
            productName: true,
            serialNumber: true,
            purchaseDate: true,
            issueSummary: true,
            retailer: true,
            warrantyStatus: true,
            missingInfo: true,
            events: {
              where: {
                eventType: "STATUS_TRANSITION",
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                payload: true,
              },
            },
            extractions: {
              select: {
                provider: true,
                model: true,
                confidence: true,
              },
            },
          },
        });

        assert.equal(claim.status, "READY");
        assert.equal(claim.processingLeaseToken, null);
        assert.equal(claim.processingLeaseClaimedAt, null);
        assert.equal(claim.customerName, "Ada Lovelace");
        assert.equal(claim.productName, "Premium Blender");
        assert.equal(claim.serialNumber, "SN-12345");
        assert.equal(claim.purchaseDate?.toISOString(), "2026-02-14T00:00:00.000Z");
        assert.equal(claim.issueSummary, "Motor stopped spinning");
        assert.equal(claim.retailer, "Target");
        assert.equal(claim.warrantyStatus, "LIKELY_IN_WARRANTY");
        assert.deepEqual(claim.missingInfo, []);
        assert.equal(claim.extractions.length, 1);
        assert.equal(claim.extractions[0]?.provider, "FALLBACK");
        assert.equal(claim.extractions[0]?.model, "smoke-test-model");
        assert.equal(claim.extractions[0]?.confidence, 0.97);
        assert.equal(claim.events.length, 2);
        assert.deepEqual(readPayloadRecord(claim.events[0]?.payload), {
          fromStatus: "NEW",
          toStatus: "PROCESSING",
          source: "webhook_enqueue",
          inboundMessageId,
          providerMessageId,
          queueMessageId: `sqs-${suffix}`,
        });
        const workerEventPayload = readPayloadRecord(claim.events[1]?.payload);
        assert.equal(workerEventPayload.fromStatus, "PROCESSING");
        assert.equal(workerEventPayload.toStatus, "READY");
        assert.equal(workerEventPayload.source, "worker_extraction");
        assert.equal(workerEventPayload.confidence, 0.97);
        assert.equal(workerEventPayload.fallbackUsed, false);
        assert.equal(typeof workerEventPayload.extractionId, "string");
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

test("full pipeline smoke moves failed worker claims to the DLQ and marks them ERROR", async () => {
  const suffix = randomUUID();
  const mailboxHash = `mailbox-${suffix}`;
  const providerMessageId = `message-${suffix}`;
  const authHeader = `Basic ${Buffer.from("smoke-user:smoke-pass").toString("base64")}`;
  let capturedQueueMessage: ClaimIngestQueueMessage | null = null;
  const queueTransport = createQueueTransportRecorder();

  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "smoke-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "smoke-pass",
    },
    async () => {
      const organization = await prisma.organization.create({
        data: {
          name: `Pipeline Smoke Failure ${suffix}`,
          slug: `pipeline-smoke-failure-${suffix}`,
          integrationMailbox: {
            create: {
              provider: "POSTMARK",
              mailboxHash,
              emailAddress: `claims+${suffix}@example.com`,
            },
          },
        },
        select: {
          id: true,
        },
      });

      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
        maybeEnqueueClaimForProcessingFn: (input) =>
          maybeEnqueueClaimForProcessing(input, {
            prismaClient: prisma,
            enqueueClaimIngestJobFn: async (queueInput) => {
              capturedQueueMessage = buildEnqueuedQueueMessage(
                queueInput,
                "2026-03-06T12:05:00.000Z",
              );

              return {
                enqueued: true,
                queueUrl: "https://example.invalid/claims",
                messageId: `sqs-failure-${suffix}`,
              };
            },
          }),
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: providerMessageId,
              MailboxHash: mailboxHash,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Warranty request that will fail",
              TextBody:
                "Customer submitted a warranty request, but the worker smoke path will force a processing failure.",
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 200);

        const body = (await response.json()) as Record<string, unknown>;
        const claimId = body.claimId as string;
        const inboundMessageId = body.messageId as string;

        assert.equal(body.ok, true);
        assert.equal(body.claimStatus, "PROCESSING");
        assert.deepEqual(body.queue, {
          enqueued: true,
          queueUrl: "https://example.invalid/claims",
          messageId: `sqs-failure-${suffix}`,
        });

        assert.notEqual(capturedQueueMessage, null);
        assert.equal(capturedQueueMessage?.version, 3);
        assert.equal(capturedQueueMessage?.processingAttempt, 1);
        assert.equal(typeof capturedQueueMessage?.processingLeaseToken, "string");

        await handleClaimQueueMessage(
          {
            config: buildWorkerQueueConfig({
              dlqUrl: "https://example.invalid/claims-dlq",
            }),
            sqsClient: queueTransport.sqsClient,
            sqsMessage: {
              MessageId: `sqs-failure-${suffix}`,
              ReceiptHandle: `receipt-failure-${suffix}`,
              Body: JSON.stringify(capturedQueueMessage),
              Attributes: {
                ApproximateReceiveCount: "3",
              },
            },
          },
          {
            processClaimIngestJobFn: (jobConfig, queueMessage) =>
              processClaimIngestJob(prisma, jobConfig, queueMessage, {
                extractClaimDataFn: async () => {
                  throw new Error("simulated extraction failure");
                },
              }),
            markClaimAsErrorFn: (input) => markClaimAsError(prisma, input),
            releaseClaimProcessingLeaseFn: (input) => releaseClaimProcessingLease(prisma, input),
            logInfoFn: () => {},
            logErrorFn: () => {},
          },
        );

        assert.deepEqual(queueTransport.deletedReceiptHandles, [`receipt-failure-${suffix}`]);
        assert.equal(queueTransport.sentMessages.length, 1);
        assert.equal(queueTransport.sentMessages[0]?.queueUrl, "https://example.invalid/claims-dlq");

        const dlqPayload = JSON.parse(queueTransport.sentMessages[0]?.body ?? "null") as Record<
          string,
          unknown
        >;
        assert.equal(typeof dlqPayload.failedAt, "string");
        assert.equal(dlqPayload.reason, "simulated extraction failure");
        assert.equal(dlqPayload.retryable, true);
        assert.equal(dlqPayload.receiveCount, 3);
        assert.equal(dlqPayload.originalMessageId, `sqs-failure-${suffix}`);
        assert.deepEqual(dlqPayload.queueMessage, capturedQueueMessage);

        const claim = await prisma.claim.findUniqueOrThrow({
          where: { id: claimId },
          select: {
            status: true,
            processingLeaseToken: true,
            processingLeaseClaimedAt: true,
            events: {
              where: {
                eventType: "STATUS_TRANSITION",
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                payload: true,
              },
            },
            extractions: {
              select: {
                id: true,
              },
            },
          },
        });

        assert.equal(claim.status, "ERROR");
        assert.equal(claim.processingLeaseToken, null);
        assert.equal(claim.processingLeaseClaimedAt, null);
        assert.equal(claim.extractions.length, 0);
        assert.equal(claim.events.length, 2);
        assert.deepEqual(readPayloadRecord(claim.events[0]?.payload), {
          fromStatus: "NEW",
          toStatus: "PROCESSING",
          source: "webhook_enqueue",
          inboundMessageId,
          providerMessageId,
          queueMessageId: `sqs-failure-${suffix}`,
        });

        const workerFailurePayload = readPayloadRecord(claim.events[1]?.payload);
        assert.equal(workerFailurePayload.fromStatus, "PROCESSING");
        assert.equal(workerFailurePayload.toStatus, "ERROR");
        assert.equal(workerFailurePayload.source, "worker_failure");
        assert.equal(workerFailurePayload.failureDisposition, "moved_to_dlq");
        assert.equal(workerFailurePayload.receiveCount, 3);
        assert.equal(workerFailurePayload.retryable, true);
        assert.equal(workerFailurePayload.reason, "simulated extraction failure");
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

test("full pipeline smoke retains source messages when DLQ publishing fails", async () => {
  const suffix = randomUUID();
  const mailboxHash = `mailbox-${suffix}`;
  const providerMessageId = `message-${suffix}`;
  const authHeader = `Basic ${Buffer.from("smoke-user:smoke-pass").toString("base64")}`;
  let capturedQueueMessage: ClaimIngestQueueMessage | null = null;
  const queueTransport = createQueueTransportRecorder({
    failSendQueueUrl: "https://example.invalid/claims-dlq",
  });

  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "smoke-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "smoke-pass",
    },
    async () => {
      const organization = await prisma.organization.create({
        data: {
          name: `Pipeline Smoke DLQ Failure ${suffix}`,
          slug: `pipeline-smoke-dlq-failure-${suffix}`,
          integrationMailbox: {
            create: {
              provider: "POSTMARK",
              mailboxHash,
              emailAddress: `claims+${suffix}@example.com`,
            },
          },
        },
        select: {
          id: true,
        },
      });

      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
        maybeEnqueueClaimForProcessingFn: (input) =>
          maybeEnqueueClaimForProcessing(input, {
            prismaClient: prisma,
            enqueueClaimIngestJobFn: async (queueInput) => {
              capturedQueueMessage = buildEnqueuedQueueMessage(
                queueInput,
                "2026-03-06T12:10:00.000Z",
              );

              return {
                enqueued: true,
                queueUrl: "https://example.invalid/claims",
                messageId: `sqs-dlq-failure-${suffix}`,
              };
            },
          }),
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: providerMessageId,
              MailboxHash: mailboxHash,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Warranty request with broken DLQ",
              TextBody:
                "Customer submitted a warranty request, and the smoke test will force the DLQ write to fail.",
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 200);

        const body = (await response.json()) as Record<string, unknown>;
        const claimId = body.claimId as string;
        const inboundMessageId = body.messageId as string;

        assert.equal(body.ok, true);
        assert.equal(body.claimStatus, "PROCESSING");
        assert.deepEqual(body.queue, {
          enqueued: true,
          queueUrl: "https://example.invalid/claims",
          messageId: `sqs-dlq-failure-${suffix}`,
        });

        assert.notEqual(capturedQueueMessage, null);
        assert.equal(capturedQueueMessage?.version, 3);
        assert.equal(capturedQueueMessage?.processingAttempt, 1);
        assert.equal(typeof capturedQueueMessage?.processingLeaseToken, "string");

        await handleClaimQueueMessage(
          {
            config: buildWorkerQueueConfig({
              dlqUrl: "https://example.invalid/claims-dlq",
            }),
            sqsClient: queueTransport.sqsClient,
            sqsMessage: {
              MessageId: `sqs-dlq-failure-${suffix}`,
              ReceiptHandle: `receipt-dlq-failure-${suffix}`,
              Body: JSON.stringify(capturedQueueMessage),
              Attributes: {
                ApproximateReceiveCount: "3",
              },
            },
          },
          {
            processClaimIngestJobFn: (jobConfig, queueMessage) =>
              processClaimIngestJob(prisma, jobConfig, queueMessage, {
                extractClaimDataFn: async () => {
                  throw new Error("simulated extraction failure");
                },
              }),
            markClaimAsErrorFn: (input) => markClaimAsError(prisma, input),
            releaseClaimProcessingLeaseFn: (input) => releaseClaimProcessingLease(prisma, input),
            logInfoFn: () => {},
            logErrorFn: () => {},
          },
        );

        assert.deepEqual(queueTransport.deletedReceiptHandles, []);
        assert.equal(queueTransport.sentMessages.length, 1);
        assert.equal(queueTransport.sentMessages[0]?.queueUrl, "https://example.invalid/claims-dlq");

        const claim = await prisma.claim.findUniqueOrThrow({
          where: { id: claimId },
          select: {
            status: true,
            processingLeaseToken: true,
            processingLeaseClaimedAt: true,
            events: {
              where: {
                eventType: "STATUS_TRANSITION",
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                payload: true,
              },
            },
            extractions: {
              select: {
                id: true,
              },
            },
          },
        });

        assert.equal(claim.status, "PROCESSING");
        assert.equal(typeof claim.processingLeaseToken, "string");
        assert.equal(claim.processingLeaseClaimedAt, null);
        assert.equal(claim.extractions.length, 0);
        assert.equal(claim.events.length, 1);
        assert.deepEqual(readPayloadRecord(claim.events[0]?.payload), {
          fromStatus: "NEW",
          toStatus: "PROCESSING",
          source: "webhook_enqueue",
          inboundMessageId,
          providerMessageId,
          queueMessageId: `sqs-dlq-failure-${suffix}`,
        });
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

function buildReadyExtraction(): ClaimExtractionResult {
  return {
    provider: "FALLBACK",
    model: "smoke-test-model",
    schemaVersion: 1,
    extraction: {
      customerName: "Ada Lovelace",
      productName: "Premium Blender",
      serialNumber: "SN-12345",
      purchaseDate: "2026-02-14",
      issueSummary: "Motor stopped spinning",
      retailer: "Target",
      warrantyStatus: "LIKELY_IN_WARRANTY",
      missingInfo: [],
      confidence: 0.97,
      reasoning: "Smoke test extraction",
    },
    rawOutput: {
      source: "full-pipeline-smoke-test",
    },
  };
}

function buildWorkerQueueConfig(
  overrides: Partial<
    ClaimIngestJobConfig & {
      queueUrl: string;
      dlqUrl: string | null;
      maxReceiveCount: number;
    }
  > = {},
): ClaimIngestJobConfig & {
  queueUrl: string;
  dlqUrl: string | null;
  maxReceiveCount: number;
} {
  return {
    queueUrl: "https://example.invalid/claims",
    dlqUrl: null,
    maxReceiveCount: 3,
    awsRegion: "us-west-2",
    openAiApiKey: null,
    extractionModel: "test-model",
    extractionReadyConfidence: 0.85,
    extractionMaxInputChars: 8_000,
    textractFallbackEnabled: false,
    textractFallbackConfidenceThreshold: 0.75,
    textractFallbackMissingInfoCount: 2,
    textractFallbackMinInboundChars: 250,
    textractMaxAttachments: 3,
    textractMaxTextChars: 12_000,
    ...overrides,
  };
}

function buildEnqueuedQueueMessage(
  input: {
    claimId: string;
    organizationId: string;
    inboundMessageId: string;
    providerMessageId: string;
    processingAttempt?: number;
    processingLeaseToken?: string;
  },
  enqueuedAt: string,
): ClaimIngestQueueMessage {
  if (
    typeof input.processingAttempt === "number" &&
    Number.isInteger(input.processingAttempt) &&
    input.processingAttempt > 0 &&
    typeof input.processingLeaseToken === "string" &&
    input.processingLeaseToken.length > 0
  ) {
    return {
      version: 3,
      claimId: input.claimId,
      organizationId: input.organizationId,
      inboundMessageId: input.inboundMessageId,
      providerMessageId: input.providerMessageId,
      enqueuedAt,
      processingAttempt: input.processingAttempt,
      processingLeaseToken: input.processingLeaseToken,
    };
  }

  if (
    typeof input.processingAttempt === "number" &&
    Number.isInteger(input.processingAttempt) &&
    input.processingAttempt > 0
  ) {
    return {
      version: 2,
      claimId: input.claimId,
      organizationId: input.organizationId,
      inboundMessageId: input.inboundMessageId,
      providerMessageId: input.providerMessageId,
      enqueuedAt,
      processingAttempt: input.processingAttempt,
    };
  }

  return {
    version: 1,
    claimId: input.claimId,
    organizationId: input.organizationId,
    inboundMessageId: input.inboundMessageId,
    providerMessageId: input.providerMessageId,
    enqueuedAt,
  };
}

function createQueueTransportRecorder(
  options: {
    failSendQueueUrl?: string;
  } = {},
) {
  const deletedReceiptHandles: string[] = [];
  const sentMessages: Array<{
    queueUrl: string | null;
    body: string | null;
  }> = [];

  return {
    deletedReceiptHandles,
    sentMessages,
    sqsClient: {
      send: async (command: unknown) => {
        const commandName = getCommandName(command);
        const commandInput = getCommandInput(command);

        if (commandName === "DeleteMessageCommand") {
          deletedReceiptHandles.push(String(commandInput?.ReceiptHandle ?? ""));
        }

        if (commandName === "SendMessageCommand") {
          const message = {
            queueUrl:
              typeof commandInput?.QueueUrl === "string" ? commandInput.QueueUrl : null,
            body: typeof commandInput?.MessageBody === "string" ? commandInput.MessageBody : null,
          };
          sentMessages.push(message);

          if (message.queueUrl === options.failSendQueueUrl) {
            throw new Error("simulated dlq publish failure");
          }
        }

        return {};
      },
    },
  };
}

function readPayloadRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function getCommandName(command: unknown): string | null {
  if (typeof command !== "object" || command === null || !("constructor" in command)) {
    return null;
  }

  const constructor = (command as { constructor?: { name?: string } }).constructor;
  return typeof constructor?.name === "string" ? constructor.name : null;
}

function getCommandInput(command: unknown): Record<string, unknown> | null {
  if (typeof command !== "object" || command === null || !("input" in command)) {
    return null;
  }

  const input = (command as { input?: unknown }).input;
  if (typeof input !== "object" || input === null) {
    return null;
  }

  return input as Record<string, unknown>;
}

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previousValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
  }
}
