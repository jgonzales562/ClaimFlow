import { transitionClaimStatusIfCurrent } from "@claimflow/db";
import {
  markClaimAsError,
  persistClaimExtractionOutcome,
} from "./claim-state.js";
import {
  deleteMessageFromQueue,
  handleQueueProcessingFailure,
  type ClaimIngestQueueMessage,
} from "./queue-disposition.js";
import {
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Message } from "@aws-sdk/client-sqs";
import * as Sentry from "@sentry/node";
import { PrismaClient, type Prisma } from "@prisma/client";
import { extractErrorMessage } from "./errors.js";
import { extractClaimData, type ClaimExtractionResult } from "./extraction.js";
import { extractAttachmentTextWithTextract } from "./textract.js";

const prisma = new PrismaClient();

type WorkerConfig = {
  awsRegion: string;
  queueUrl: string;
  dlqUrl: string | null;
  pollWaitSeconds: number;
  visibilityTimeoutSeconds: number | undefined;
  maxMessages: number;
  processingConcurrency: number;
  maxReceiveCount: number;
  idleDelayMs: number;
  errorDelayMs: number;
  openAiApiKey: string | null;
  extractionModel: string;
  extractionReadyConfidence: number;
  extractionMaxInputChars: number;
  textractFallbackEnabled: boolean;
  textractFallbackConfidenceThreshold: number;
  textractFallbackMissingInfoCount: number;
  textractFallbackMinInboundChars: number;
  textractMaxAttachments: number;
  textractMaxTextChars: number;
  sentryDsn: string | null;
  sentryEnvironment: string;
  sentryTracesSampleRate: number;
};

class WorkerMessageError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "WorkerMessageError";
    this.retryable = retryable;
  }
}

let workerSentryEnabled = false;

void bootstrap();

async function bootstrap(): Promise<void> {
  let config: WorkerConfig | null = null;

  try {
    config = loadConfig();
    initWorkerSentry(config);
    process.on("uncaughtException", (error: Error) => {
      captureWorkerException(error, { stage: "uncaught_exception" });
      logError("worker_uncaught_exception", { error: extractErrorMessage(error) });
    });
    process.on("unhandledRejection", (reason: unknown) => {
      captureWorkerException(reason, { stage: "unhandled_rejection" });
      logError("worker_unhandled_rejection", { error: extractErrorMessage(reason) });
    });
    const sqsClient = new SQSClient({
      region: config.awsRegion,
    });
    await runWorkerLoop(config, sqsClient);
  } catch (error: unknown) {
    captureWorkerException(error, {
      stage: "bootstrap",
      queueUrl: config?.queueUrl ?? null,
      awsRegion: config?.awsRegion ?? null,
    });

    logError("worker_startup_failed", { error: extractErrorMessage(error) });
    process.exitCode = 1;
  } finally {
    if (isWorkerSentryEnabled()) {
      await Sentry.flush(2_000);
    }
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
    processingConcurrency: config.processingConcurrency,
    maxReceiveCount: config.maxReceiveCount,
    extractionModel: config.extractionModel,
    extractionReadyConfidence: config.extractionReadyConfidence,
    textractFallbackEnabled: config.textractFallbackEnabled,
    textractFallbackConfidenceThreshold: config.textractFallbackConfidenceThreshold,
    sentryEnabled: Boolean(config.sentryDsn),
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
      captureWorkerException(error, {
        stage: "receive_message",
        queueUrl: config.queueUrl,
      });
      logError("queue_receive_failed", { error: extractErrorMessage(error) });
      await sleep(config.errorDelayMs);
      continue;
    }

    if (messages.length === 0) {
      await sleep(config.idleDelayMs);
      continue;
    }

    const inFlight = new Set<Promise<void>>();
    for (const message of messages) {
      if (shuttingDown) {
        break;
      }

      const task = handleQueueMessage(config, sqsClient, message).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);

      if (inFlight.size >= config.processingConcurrency) {
        await Promise.race(inFlight);
      }
    }

    if (inFlight.size > 0) {
      await Promise.all(inFlight);
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
    await handleQueueProcessingFailure(
      {
        config,
        sqsClient,
        sqsMessage,
        receiptHandle,
        receiveCount,
        reason: extractErrorMessage(error),
        retryable: isRetryableError(error),
        queueMessage: null,
      },
      {
        captureExceptionFn: captureWorkerException,
        logErrorFn: logError,
        markClaimAsErrorFn: async (failureInput) => {
          await markClaimAsError(prisma, failureInput);
        },
      },
    );
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
    await handleQueueProcessingFailure(
      {
        config,
        sqsClient,
        sqsMessage,
        receiptHandle,
        receiveCount,
        reason: extractErrorMessage(error),
        retryable: isRetryableError(error),
        queueMessage,
      },
      {
        captureExceptionFn: captureWorkerException,
        logErrorFn: logError,
        markClaimAsErrorFn: async (failureInput) => {
          await markClaimAsError(prisma, failureInput);
        },
      },
    );
  }
}

async function processClaimIngestJob(
  config: WorkerConfig,
  message: ClaimIngestQueueMessage,
): Promise<void> {
  const inboundMessage = await prisma.inboundMessage.findUnique({
    where: { id: message.inboundMessageId },
    select: {
      id: true,
      providerMessageId: true,
      fromEmail: true,
      subject: true,
      textBody: true,
      strippedTextReply: true,
      claim: {
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
      },
    },
  });

  if (!inboundMessage) {
    throw new WorkerMessageError(
      `Inbound message "${message.inboundMessageId}" was not found for claim "${message.claimId}".`,
      false,
    );
  }

  if (!inboundMessage.claim) {
    throw new WorkerMessageError(
      `Claim "${message.claimId}" was not found for ingest processing.`,
      false,
    );
  }

  const claim = inboundMessage.claim;

  if (claim.id !== message.claimId) {
    throw new WorkerMessageError(
      `Inbound message "${inboundMessage.id}" does not belong to claim "${message.claimId}".`,
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

  if (claim.status !== "PROCESSING") {
    await prisma.$transaction(async (tx) => {
      await transitionClaimStatusIfCurrent({
        tx,
        organizationId: claim.organizationId,
        claimId: claim.id,
        fromStatus: claim.status,
        toStatus: "PROCESSING",
        payload: {
          source: "worker_ingest_start",
          inboundMessageId: message.inboundMessageId,
          providerMessageId: message.providerMessageId,
        },
      });
    });
  }

  const runExtraction = (supplementalText: string | null) =>
    extractClaimData(
      {
        providerMessageId: inboundMessage.providerMessageId,
        fromEmail: inboundMessage.fromEmail,
        subject: inboundMessage.subject,
        textBody: inboundMessage.textBody,
        strippedTextReply: inboundMessage.strippedTextReply,
        claimIssueSummary: claim.issueSummary,
        supplementalText,
      },
      {
        openAiApiKey: config.openAiApiKey,
        model: config.extractionModel,
        maxInputChars: config.extractionMaxInputChars,
      },
    );

  const primaryExtractionResult = await runExtraction(null);

  const inboundTextChars = getInboundTextCharCount(inboundMessage);

  const storedAttachments = await prisma.claimAttachment.findMany({
    where: {
      claimId: claim.id,
      uploadStatus: "STORED",
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      originalFilename: true,
      contentType: true,
      s3Bucket: true,
      s3Key: true,
    },
    take: config.textractMaxAttachments,
  });

  let textractMetadata: Prisma.InputJsonValue = {
    attempted: false,
    reason: "not_triggered",
  };
  let secondaryExtractionResult: ClaimExtractionResult | null = null;

  const shouldAttemptTextract =
    storedAttachments.length > 0 &&
    shouldRunTextractFallback({
      confidence: primaryExtractionResult.extraction.confidence,
      missingInfoCount: primaryExtractionResult.extraction.missingInfo.length,
      inboundTextChars,
      config,
    });

  if (shouldAttemptTextract) {
    const textractResult = await extractAttachmentTextWithTextract({
      region: config.awsRegion,
      attachments: storedAttachments,
      config: {
        enabled: config.textractFallbackEnabled,
        maxAttachments: config.textractMaxAttachments,
        maxTextChars: config.textractMaxTextChars,
      },
    });

    textractMetadata = textractResult as Prisma.InputJsonValue;

    if (textractResult.text) {
      try {
        secondaryExtractionResult = await runExtraction(textractResult.text);
      } catch (error: unknown) {
        logError("textract_reextraction_failed", {
          claimId: claim.id,
          inboundMessageId: inboundMessage.id,
          error: extractErrorMessage(error),
        });
      }
    }
  } else {
    textractMetadata = {
      attempted: false,
      reason:
        storedAttachments.length === 0 ? "no_stored_attachments" : "quality_threshold_not_met",
      attachmentsAvailable: storedAttachments.length,
      inboundTextChars,
    } as Prisma.InputJsonValue;
  }

  const selectedExtraction = choosePreferredExtraction(
    primaryExtractionResult,
    secondaryExtractionResult,
  );

  const usedTextractPass =
    secondaryExtractionResult !== null && selectedExtraction === secondaryExtractionResult;

  const extractionSource =
    selectedExtraction.provider === "FALLBACK"
      ? usedTextractPass
        ? "fallback_local_textract"
        : "fallback_local"
      : usedTextractPass
        ? "textract_fallback"
        : "openai_direct";

  await persistClaimExtractionOutcome(prisma, {
    claim,
    inboundMessageId: inboundMessage.id,
    selectedExtraction,
    primaryRawOutput: primaryExtractionResult.rawOutput,
    secondaryRawOutput: secondaryExtractionResult?.rawOutput ?? null,
    extractionSource,
    shouldAttemptTextract,
    usedTextractPass,
    textractMetadata,
    inboundTextChars,
    extractionReadyConfidence: config.extractionReadyConfidence,
  });
}

function shouldRunTextractFallback(input: {
  confidence: number;
  missingInfoCount: number;
  inboundTextChars: number;
  config: WorkerConfig;
}): boolean {
  if (!input.config.textractFallbackEnabled) {
    return false;
  }

  return (
    input.confidence < input.config.textractFallbackConfidenceThreshold ||
    input.missingInfoCount >= input.config.textractFallbackMissingInfoCount ||
    input.inboundTextChars < input.config.textractFallbackMinInboundChars
  );
}

function choosePreferredExtraction(
  primary: ClaimExtractionResult,
  secondary: ClaimExtractionResult | null,
): ClaimExtractionResult {
  if (!secondary) {
    return primary;
  }

  const primaryScore = extractionQualityScore(primary);
  const secondaryScore = extractionQualityScore(secondary);
  if (secondaryScore > primaryScore) {
    return secondary;
  }

  return primary;
}

function extractionQualityScore(result: ClaimExtractionResult): number {
  const extracted = result.extraction;
  const populatedFields = [
    extracted.customerName,
    extracted.productName,
    extracted.serialNumber,
    extracted.purchaseDate,
    extracted.issueSummary,
    extracted.retailer,
  ].filter((value) => Boolean(value)).length;

  return extracted.confidence * 100 + populatedFields * 4 - extracted.missingInfo.length * 3;
}

function getInboundTextCharCount(input: {
  textBody: string | null;
  strippedTextReply: string | null;
  subject: string | null;
}): number {
  return [input.subject, input.strippedTextReply, input.textBody]
    .filter((value): value is string => Boolean(value))
    .reduce((total, value) => total + value.trim().length, 0);
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
    processingConcurrency: parseIntegerEnv("CLAIMS_WORKER_CONCURRENCY", 1, 1, 10),
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
    textractFallbackEnabled: parseBooleanEnv("CLAIMS_TEXTRACT_FALLBACK_ENABLED", true),
    textractFallbackConfidenceThreshold: parseNumberEnv(
      "CLAIMS_TEXTRACT_FALLBACK_CONFIDENCE_THRESHOLD",
      0.75,
      0,
      1,
    ),
    textractFallbackMissingInfoCount: parseIntegerEnv(
      "CLAIMS_TEXTRACT_FALLBACK_MISSING_INFO_COUNT",
      3,
      1,
      20,
    ),
    textractFallbackMinInboundChars: parseIntegerEnv(
      "CLAIMS_TEXTRACT_FALLBACK_MIN_INBOUND_CHARS",
      120,
      0,
      20_000,
    ),
    textractMaxAttachments: parseIntegerEnv("CLAIMS_TEXTRACT_MAX_ATTACHMENTS", 5, 1, 20),
    textractMaxTextChars: parseIntegerEnv("CLAIMS_TEXTRACT_MAX_TEXT_CHARS", 30_000, 500, 200_000),
    sentryDsn: optionalEnv("SENTRY_DSN"),
    sentryEnvironment:
      optionalEnv("SENTRY_ENVIRONMENT") ?? optionalEnv("NODE_ENV") ?? "development",
    sentryTracesSampleRate: parseNumberEnv("SENTRY_TRACES_SAMPLE_RATE", 0.1, 0, 1),
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

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (raw === "true" || raw === "1" || raw === "yes") {
    return true;
  }
  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }

  throw new Error(`${name} must be a boolean value (true/false).`);
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function initWorkerSentry(config: WorkerConfig): void {
  if (!config.sentryDsn || workerSentryEnabled) {
    return;
  }

  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.sentryEnvironment,
    tracesSampleRate: config.sentryTracesSampleRate,
  });

  workerSentryEnabled = true;
}

function isWorkerSentryEnabled(): boolean {
  return workerSentryEnabled;
}

function captureWorkerException(
  error: unknown,
  context: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!workerSentryEnabled) {
    return;
  }

  const captureTarget = error instanceof Error ? error : new Error(String(error));

  Sentry.withScope((scope) => {
    scope.setTag("service", "worker");
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) {
        continue;
      }
      scope.setExtra(key, value);
    }

    Sentry.captureException(captureTarget);
  });
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
