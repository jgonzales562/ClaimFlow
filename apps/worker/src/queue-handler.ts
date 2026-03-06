import type { Message } from "@aws-sdk/client-sqs";
import {
  deleteMessageFromQueue,
  handleQueueProcessingFailure,
  type ClaimIngestQueueMessage,
  type MarkClaimAsErrorInput,
  type QueueSqsClient,
} from "./queue-disposition.js";
import { extractErrorMessage } from "./errors.js";

export type { ClaimIngestQueueMessage } from "./queue-disposition.js";

export class WorkerMessageError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "WorkerMessageError";
    this.retryable = retryable;
  }
}

type QueueMessageHandlerConfig = {
  queueUrl: string;
  dlqUrl: string | null;
  maxReceiveCount: number;
};

type QueueMessageHandlerDependencies<TConfig extends QueueMessageHandlerConfig> = {
  processClaimIngestJobFn: (config: TConfig, queueMessage: ClaimIngestQueueMessage) => Promise<void>;
  markClaimAsErrorFn: (input: MarkClaimAsErrorInput) => Promise<void>;
  captureExceptionFn?: (
    error: unknown,
    context: Record<string, string | number | boolean | null | undefined>,
  ) => void;
  logInfoFn: (event: string, context: Record<string, unknown>) => void;
  logErrorFn: (event: string, context: Record<string, unknown>) => void;
};

export async function handleClaimQueueMessage<TConfig extends QueueMessageHandlerConfig>(
  input: {
    config: TConfig;
    sqsClient: QueueSqsClient;
    sqsMessage: Message;
  },
  dependencies: QueueMessageHandlerDependencies<TConfig>,
): Promise<void> {
  const messageId = input.sqsMessage.MessageId ?? "unknown";
  const receiptHandle = input.sqsMessage.ReceiptHandle;
  const receiveCount = parseReceiveCount(input.sqsMessage);

  if (!receiptHandle) {
    dependencies.logErrorFn("queue_message_missing_receipt_handle", { messageId });
    return;
  }

  let queueMessage: ClaimIngestQueueMessage;
  try {
    queueMessage = parseQueueMessage(input.sqsMessage.Body);
  } catch (error: unknown) {
    await handleQueueProcessingFailure(
      {
        config: input.config,
        sqsClient: input.sqsClient,
        sqsMessage: input.sqsMessage,
        receiptHandle,
        receiveCount,
        reason: extractErrorMessage(error),
        retryable: isRetryableError(error),
        queueMessage: null,
      },
      {
        captureExceptionFn: dependencies.captureExceptionFn,
        logErrorFn: dependencies.logErrorFn,
        markClaimAsErrorFn: dependencies.markClaimAsErrorFn,
      },
    );
    return;
  }

  try {
    await dependencies.processClaimIngestJobFn(input.config, queueMessage);
    await deleteMessageFromQueue({
      sqsClient: input.sqsClient,
      queueUrl: input.config.queueUrl,
      receiptHandle,
    });

    dependencies.logInfoFn("claim_ingest_processed", {
      messageId,
      claimId: queueMessage.claimId,
      organizationId: queueMessage.organizationId,
      inboundMessageId: queueMessage.inboundMessageId,
    });
  } catch (error: unknown) {
    await handleQueueProcessingFailure(
      {
        config: input.config,
        sqsClient: input.sqsClient,
        sqsMessage: input.sqsMessage,
        receiptHandle,
        receiveCount,
        reason: extractErrorMessage(error),
        retryable: isRetryableError(error),
        queueMessage,
      },
      {
        captureExceptionFn: dependencies.captureExceptionFn,
        logErrorFn: dependencies.logErrorFn,
        markClaimAsErrorFn: dependencies.markClaimAsErrorFn,
      },
    );
  }
}

export function parseQueueMessage(body: string | undefined): ClaimIngestQueueMessage {
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

export function parseReceiveCount(message: Message): number {
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

export function isRetryableError(error: unknown): boolean {
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
