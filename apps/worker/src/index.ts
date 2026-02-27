import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Message } from "@aws-sdk/client-sqs";
import { PrismaClient, type Prisma } from "@prisma/client";
import { extractClaimData } from "./extraction.js";

const prisma = new PrismaClient();

type ClaimIngestQueueMessage = {
  version: 1;
  claimId: string;
  organizationId: string;
  inboundMessageId: string;
  providerMessageId: string;
  enqueuedAt: string;
};

type WorkerConfig = {
  awsRegion: string;
  queueUrl: string;
  dlqUrl: string | null;
  pollWaitSeconds: number;
  visibilityTimeoutSeconds: number | undefined;
  maxMessages: number;
  maxReceiveCount: number;
  idleDelayMs: number;
  errorDelayMs: number;
  openAiApiKey: string | null;
  extractionModel: string;
  extractionReadyConfidence: number;
  extractionMaxInputChars: number;
};

class WorkerMessageError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "WorkerMessageError";
    this.retryable = retryable;
  }
}

void bootstrap();

async function bootstrap(): Promise<void> {
  try {
    const config = loadConfig();
    const sqsClient = new SQSClient({ region: config.awsRegion });
    await runWorkerLoop(config, sqsClient);
  } catch (error: unknown) {
    logError("worker_startup_failed", { error: extractErrorMessage(error) });
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

async function runWorkerLoop(config: WorkerConfig, sqsClient: SQSClient): Promise<void> {
  let shuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo("worker_signal_received", { signal });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  logInfo("worker_started", {
    queueUrl: config.queueUrl,
    dlqUrl: config.dlqUrl,
    pollWaitSeconds: config.pollWaitSeconds,
    maxMessages: config.maxMessages,
    maxReceiveCount: config.maxReceiveCount,
    extractionModel: config.extractionModel,
    extractionReadyConfidence: config.extractionReadyConfidence,
  });

  while (!shuttingDown) {
    let messages: Message[];

    try {
      const response = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: config.queueUrl,
          MaxNumberOfMessages: config.maxMessages,
          WaitTimeSeconds: config.pollWaitSeconds,
          VisibilityTimeout: config.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      messages = response.Messages ?? [];
    } catch (error: unknown) {
      logError("queue_receive_failed", { error: extractErrorMessage(error) });
      await sleep(config.errorDelayMs);
      continue;
    }

    if (messages.length === 0) {
      await sleep(config.idleDelayMs);
      continue;
    }

    for (const message of messages) {
      if (shuttingDown) {
        break;
      }
      await handleQueueMessage(config, sqsClient, message);
    }
  }

  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);
  logInfo("worker_stopped", {});
}

async function handleQueueMessage(
  config: WorkerConfig,
  sqsClient: SQSClient,
  sqsMessage: Message,
): Promise<void> {
  const messageId = sqsMessage.MessageId ?? "unknown";
  const receiptHandle = sqsMessage.ReceiptHandle;
  const receiveCount = parseReceiveCount(sqsMessage);

  if (!receiptHandle) {
    logError("queue_message_missing_receipt_handle", { messageId });
    return;
  }

  let queueMessage: ClaimIngestQueueMessage;
  try {
    queueMessage = parseQueueMessage(sqsMessage.Body);
  } catch (error: unknown) {
    await handleProcessingFailure({
      config,
      sqsClient,
      sqsMessage,
      receiptHandle,
      receiveCount,
      reason: extractErrorMessage(error),
      retryable: isRetryableError(error),
      queueMessage: null,
    });
    return;
  }

  try {
    await processClaimIngestJob(config, queueMessage);
    await deleteMessageFromQueue({
      sqsClient,
      queueUrl: config.queueUrl,
      receiptHandle,
    });

    logInfo("claim_ingest_processed", {
      messageId,
      claimId: queueMessage.claimId,
      organizationId: queueMessage.organizationId,
      inboundMessageId: queueMessage.inboundMessageId,
    });
  } catch (error: unknown) {
    await handleProcessingFailure({
      config,
      sqsClient,
      sqsMessage,
      receiptHandle,
      receiveCount,
      reason: extractErrorMessage(error),
      retryable: isRetryableError(error),
      queueMessage,
    });
  }
}

async function handleProcessingFailure(input: {
  config: WorkerConfig;
  sqsClient: SQSClient;
  sqsMessage: Message;
  receiptHandle: string;
  receiveCount: number;
  reason: string;
  retryable: boolean;
  queueMessage: ClaimIngestQueueMessage | null;
}): Promise<void> {
  const messageId = input.sqsMessage.MessageId ?? "unknown";
  const queueMessage = input.queueMessage;
  const shouldMoveToDlq =
    input.config.dlqUrl && (!input.retryable || input.receiveCount >= input.config.maxReceiveCount);

  if (shouldMoveToDlq) {
    const moved = await moveMessageToDlq({
      config: input.config,
      sqsClient: input.sqsClient,
      sqsMessage: input.sqsMessage,
      reason: input.reason,
      retryable: input.retryable,
      receiveCount: input.receiveCount,
      queueMessage,
    });

    if (moved) {
      await deleteMessageFromQueue({
        sqsClient: input.sqsClient,
        queueUrl: input.config.queueUrl,
        receiptHandle: input.receiptHandle,
      });

      logError("claim_ingest_moved_to_dlq", {
        messageId,
        claimId: queueMessage?.claimId ?? null,
        receiveCount: input.receiveCount,
        retryable: input.retryable,
        reason: input.reason,
      });
      return;
    }
  }

  if (!input.retryable && !input.config.dlqUrl) {
    await deleteMessageFromQueue({
      sqsClient: input.sqsClient,
      queueUrl: input.config.queueUrl,
      receiptHandle: input.receiptHandle,
    });

    logError("claim_ingest_dropped_non_retryable", {
      messageId,
      claimId: queueMessage?.claimId ?? null,
      reason: input.reason,
    });
    return;
  }

  logError("claim_ingest_failed_retrying", {
    messageId,
    claimId: queueMessage?.claimId ?? null,
    receiveCount: input.receiveCount,
    retryable: input.retryable,
    reason: input.reason,
  });
}

async function moveMessageToDlq(input: {
  config: WorkerConfig;
  sqsClient: SQSClient;
  sqsMessage: Message;
  reason: string;
  retryable: boolean;
  receiveCount: number;
  queueMessage: ClaimIngestQueueMessage | null;
}): Promise<boolean> {
  if (!input.config.dlqUrl) {
    return false;
  }

  try {
    await input.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: input.config.dlqUrl,
        MessageBody: JSON.stringify({
          failedAt: new Date().toISOString(),
          reason: input.reason,
          retryable: input.retryable,
          receiveCount: input.receiveCount,
          queueMessage: input.queueMessage,
          originalMessageId: input.sqsMessage.MessageId ?? null,
          originalBody: input.sqsMessage.Body ?? null,
        }),
        MessageAttributes: {
          failureReason: {
            DataType: "String",
            StringValue: truncate(input.reason, 256),
          },
          retryable: {
            DataType: "String",
            StringValue: input.retryable ? "true" : "false",
          },
          originalMessageId: {
            DataType: "String",
            StringValue: input.sqsMessage.MessageId ?? "unknown",
          },
        },
      }),
    );

    return true;
  } catch (error: unknown) {
    logError("queue_dlq_publish_failed", {
      error: extractErrorMessage(error),
      reason: input.reason,
      originalMessageId: input.sqsMessage.MessageId ?? null,
    });
    return false;
  }
}

async function deleteMessageFromQueue(input: {
  sqsClient: SQSClient;
  queueUrl: string;
  receiptHandle: string;
}): Promise<void> {
  await input.sqsClient.send(
    new DeleteMessageCommand({
      QueueUrl: input.queueUrl,
      ReceiptHandle: input.receiptHandle,
    }),
  );
}

async function processClaimIngestJob(
  config: WorkerConfig,
  message: ClaimIngestQueueMessage,
): Promise<void> {
  const claim = await prisma.claim.findUnique({
    where: { id: message.claimId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      customerName: true,
      productName: true,
      serialNumber: true,
      purchaseDate: true,
      issueSummary: true,
      retailer: true,
    },
  });

  if (!claim) {
    throw new WorkerMessageError(
      `Claim "${message.claimId}" was not found for ingest processing.`,
      false,
    );
  }

  if (claim.organizationId !== message.organizationId) {
    throw new WorkerMessageError(
      `Claim "${message.claimId}" does not belong to organization "${message.organizationId}".`,
      false,
    );
  }

  if (claim.status === "READY" || claim.status === "REVIEW_REQUIRED") {
    return;
  }

  await prisma.claim.update({
    where: { id: claim.id },
    data: { status: "PROCESSING" },
  });

  const inboundMessage = await prisma.inboundMessage.findUnique({
    where: { id: message.inboundMessageId },
    select: {
      id: true,
      claimId: true,
      providerMessageId: true,
      fromEmail: true,
      subject: true,
      textBody: true,
      strippedTextReply: true,
    },
  });

  if (!inboundMessage) {
    throw new WorkerMessageError(
      `Inbound message "${message.inboundMessageId}" was not found for claim "${message.claimId}".`,
      false,
    );
  }

  if (inboundMessage.claimId !== claim.id) {
    throw new WorkerMessageError(
      `Inbound message "${inboundMessage.id}" does not belong to claim "${claim.id}".`,
      false,
    );
  }

  const extractionResult = await extractClaimData(
    {
      providerMessageId: inboundMessage.providerMessageId,
      fromEmail: inboundMessage.fromEmail,
      subject: inboundMessage.subject,
      textBody: inboundMessage.textBody,
      strippedTextReply: inboundMessage.strippedTextReply,
      claimIssueSummary: claim.issueSummary,
    },
    {
      openAiApiKey: config.openAiApiKey,
      model: config.extractionModel,
      maxInputChars: config.extractionMaxInputChars,
    },
  );

  const extracted = extractionResult.extraction;
  const nextStatus =
    extracted.confidence >= config.extractionReadyConfidence && extracted.missingInfo.length === 0
      ? "READY"
      : "REVIEW_REQUIRED";

  await prisma.$transaction(async (tx) => {
    await tx.claimExtraction.create({
      data: {
        organizationId: claim.organizationId,
        claimId: claim.id,
        inboundMessageId: inboundMessage.id,
        provider: extractionResult.provider,
        model: extractionResult.model,
        schemaVersion: extractionResult.schemaVersion,
        confidence: extracted.confidence,
        extraction: extracted as Prisma.InputJsonValue,
        rawOutput: extractionResult.rawOutput as Prisma.InputJsonValue,
      },
    });

    await tx.claim.update({
      where: { id: claim.id },
      data: {
        customerName: extracted.customerName ?? claim.customerName,
        productName: extracted.productName ?? claim.productName,
        serialNumber: extracted.serialNumber ?? claim.serialNumber,
        purchaseDate: parsePurchaseDate(extracted.purchaseDate) ?? claim.purchaseDate,
        issueSummary: extracted.issueSummary ?? claim.issueSummary,
        retailer: extracted.retailer ?? claim.retailer,
        warrantyStatus: extracted.warrantyStatus,
        missingInfo: extracted.missingInfo,
        status: nextStatus,
      },
    });
  });
}

function parseQueueMessage(body: string | undefined): ClaimIngestQueueMessage {
  if (!body) {
    throw new WorkerMessageError("SQS message body is empty.", false);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new WorkerMessageError("SQS message body is not valid JSON.", false);
  }

  if (!isClaimIngestQueueMessage(parsed)) {
    throw new WorkerMessageError("SQS message body does not match claim ingest schema.", false);
  }

  return parsed;
}

function isClaimIngestQueueMessage(value: unknown): value is ClaimIngestQueueMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    hasNonEmptyString(record.claimId) &&
    hasNonEmptyString(record.organizationId) &&
    hasNonEmptyString(record.inboundMessageId) &&
    hasNonEmptyString(record.providerMessageId) &&
    hasNonEmptyString(record.enqueuedAt)
  );
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseReceiveCount(message: Message): number {
  const raw = message.Attributes?.ApproximateReceiveCount;
  if (!raw) {
    return 1;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return parsed;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof WorkerMessageError) {
    return error.retryable;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  ) {
    return (error as { retryable: boolean }).retryable;
  }

  return true;
}

function loadConfig(): WorkerConfig {
  const queueUrl = process.env.CLAIMS_INGEST_QUEUE_URL?.trim();
  if (!queueUrl) {
    throw new Error("CLAIMS_INGEST_QUEUE_URL is required for the worker.");
  }

  const awsRegion = process.env.AWS_REGION?.trim();
  if (!awsRegion) {
    throw new Error("AWS_REGION is required for the worker.");
  }

  return {
    awsRegion,
    queueUrl,
    dlqUrl: optionalEnv("CLAIMS_INGEST_DLQ_URL"),
    pollWaitSeconds: parseIntegerEnv("CLAIMS_QUEUE_POLL_WAIT_SECONDS", 20, 0, 20),
    visibilityTimeoutSeconds: parseOptionalIntegerEnv(
      "CLAIMS_QUEUE_VISIBILITY_TIMEOUT_SECONDS",
      0,
      43200,
    ),
    maxMessages: parseIntegerEnv("CLAIMS_QUEUE_MAX_MESSAGES", 5, 1, 10),
    maxReceiveCount: parseIntegerEnv("CLAIMS_QUEUE_MAX_RECEIVE_COUNT", 5, 1, 1000),
    idleDelayMs: parseIntegerEnv("CLAIMS_QUEUE_IDLE_DELAY_MS", 250, 0, 60_000),
    errorDelayMs: parseIntegerEnv("CLAIMS_QUEUE_ERROR_DELAY_MS", 2_000, 0, 60_000),
    openAiApiKey: optionalEnv("OPENAI_API_KEY"),
    extractionModel: optionalEnv("OPENAI_MODEL") ?? "gpt-4o-mini",
    extractionReadyConfidence: parseNumberEnv("CLAIMS_EXTRACTION_READY_CONFIDENCE", 0.85, 0, 1),
    extractionMaxInputChars: parseIntegerEnv(
      "CLAIMS_EXTRACTION_MAX_INPUT_CHARS",
      12_000,
      500,
      50_000,
    ),
  };
}

function parseOptionalIntegerEnv(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return value;
}

function parseIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return value;
}

function parseNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }

  return value;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function parsePurchaseDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown error.";
}

function logInfo(event: string, context: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      timestamp: new Date().toISOString(),
      ...context,
    }),
  );
}

function logError(event: string, context: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      ...context,
    }),
  );
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
