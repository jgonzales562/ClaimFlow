import {
  DeleteMessageCommand,
  SendMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { extractErrorMessage } from "./errors.js";
import { truncateString } from "./strings.js";

type ClaimIngestQueueMessageBase = {
  claimId: string;
  organizationId: string;
  inboundMessageId: string;
  providerMessageId: string;
  enqueuedAt: string;
};

export type ClaimIngestQueueMessage =
  | (ClaimIngestQueueMessageBase & {
      version: 1;
      processingAttempt?: undefined;
      processingLeaseToken?: undefined;
    })
  | (ClaimIngestQueueMessageBase & {
      version: 2;
      processingAttempt: number;
      processingLeaseToken?: undefined;
    })
  | (ClaimIngestQueueMessageBase & {
      version: 3;
      processingAttempt: number;
      processingLeaseToken: string;
    });

type QueueDispositionContextValue = string | number | boolean | null | undefined;

type QueueDispositionConfig = {
  queueUrl: string;
  dlqUrl: string | null;
  maxReceiveCount: number;
};

export type QueueSqsClient = {
  send(command: unknown): Promise<unknown>;
};

export type MarkClaimAsErrorInput = {
  claimId: string;
  organizationId: string;
  processingAttempt?: number;
  processingLeaseToken?: string;
  reason: string;
  retryable: boolean;
  receiveCount: number;
  failureDisposition: "moved_to_dlq" | "dropped_non_retryable";
};

type QueueDispositionDependencies = {
  markClaimAsErrorFn: (input: MarkClaimAsErrorInput) => Promise<void>;
  releaseClaimProcessingLeaseFn?: (input: {
    claimId: string;
    organizationId: string;
    processingAttempt?: number;
    processingLeaseToken?: string;
  }) => Promise<void>;
  captureExceptionFn?: (
    error: unknown,
    context: Record<string, QueueDispositionContextValue>,
  ) => void;
  logErrorFn: (event: string, context: Record<string, unknown>) => void;
  nowFn?: () => Date;
};

export type QueueFailureDisposition = "moved_to_dlq" | "dropped_non_retryable" | "retrying";

export async function handleQueueProcessingFailure(
  input: {
    config: QueueDispositionConfig;
    sqsClient: QueueSqsClient;
    sqsMessage: Message;
    receiptHandle: string;
    receiveCount: number;
    reason: string;
    retryable: boolean;
    queueMessage: ClaimIngestQueueMessage | null;
  },
  dependencies: QueueDispositionDependencies,
): Promise<QueueFailureDisposition> {
  const messageId = input.sqsMessage.MessageId ?? "unknown";
  const shouldMoveToDlq =
    input.config.dlqUrl && (!input.retryable || input.receiveCount >= input.config.maxReceiveCount);

  dependencies.captureExceptionFn?.(input.reason, {
    stage: "handle_processing_failure",
    messageId,
    claimId: input.queueMessage?.claimId ?? null,
    organizationId: input.queueMessage?.organizationId ?? null,
    receiveCount: input.receiveCount,
    retryable: input.retryable,
    shouldMoveToDlq: Boolean(shouldMoveToDlq),
  });

  if (shouldMoveToDlq) {
    const moved = await moveMessageToDlq(
      {
        config: input.config,
        sqsClient: input.sqsClient,
        sqsMessage: input.sqsMessage,
        reason: input.reason,
        retryable: input.retryable,
        receiveCount: input.receiveCount,
        queueMessage: input.queueMessage,
      },
      {
        logErrorFn: dependencies.logErrorFn,
        nowFn: dependencies.nowFn,
      },
    );

    if (moved) {
      if (input.queueMessage) {
        await dependencies.markClaimAsErrorFn({
          claimId: input.queueMessage.claimId,
          organizationId: input.queueMessage.organizationId,
          reason: input.reason,
          retryable: input.retryable,
          receiveCount: input.receiveCount,
          failureDisposition: "moved_to_dlq",
          ...(typeof input.queueMessage.processingAttempt === "number"
            ? {
                processingAttempt: input.queueMessage.processingAttempt,
              }
            : {}),
          ...(typeof input.queueMessage.processingLeaseToken === "string"
            ? {
                processingLeaseToken: input.queueMessage.processingLeaseToken,
              }
            : {}),
        });
      }

      await deleteMessageFromQueue({
        sqsClient: input.sqsClient,
        queueUrl: input.config.queueUrl,
        receiptHandle: input.receiptHandle,
      });

      dependencies.logErrorFn("claim_ingest_moved_to_dlq", {
        messageId,
        claimId: input.queueMessage?.claimId ?? null,
        receiveCount: input.receiveCount,
        retryable: input.retryable,
        reason: input.reason,
      });
      return "moved_to_dlq";
    }
  }

  if (!input.retryable && !input.config.dlqUrl) {
    if (input.queueMessage) {
      await dependencies.markClaimAsErrorFn({
        claimId: input.queueMessage.claimId,
        organizationId: input.queueMessage.organizationId,
        reason: input.reason,
        retryable: input.retryable,
        receiveCount: input.receiveCount,
        failureDisposition: "dropped_non_retryable",
        ...(typeof input.queueMessage.processingAttempt === "number"
          ? {
              processingAttempt: input.queueMessage.processingAttempt,
            }
          : {}),
        ...(typeof input.queueMessage.processingLeaseToken === "string"
          ? {
              processingLeaseToken: input.queueMessage.processingLeaseToken,
            }
          : {}),
      });
    }

    await deleteMessageFromQueue({
      sqsClient: input.sqsClient,
      queueUrl: input.config.queueUrl,
      receiptHandle: input.receiptHandle,
    });

    dependencies.logErrorFn("claim_ingest_dropped_non_retryable", {
      messageId,
      claimId: input.queueMessage?.claimId ?? null,
      reason: input.reason,
    });
    return "dropped_non_retryable";
  }

  dependencies.logErrorFn("claim_ingest_failed_retrying", {
    messageId,
    claimId: input.queueMessage?.claimId ?? null,
    receiveCount: input.receiveCount,
    retryable: input.retryable,
    reason: input.reason,
  });

  if (
    input.queueMessage &&
    typeof input.queueMessage.processingAttempt === "number" &&
    typeof input.queueMessage.processingLeaseToken === "string"
  ) {
    try {
      await dependencies.releaseClaimProcessingLeaseFn?.({
        claimId: input.queueMessage.claimId,
        organizationId: input.queueMessage.organizationId,
        processingAttempt: input.queueMessage.processingAttempt,
        processingLeaseToken: input.queueMessage.processingLeaseToken,
      });
    } catch (error: unknown) {
      dependencies.logErrorFn("claim_processing_lease_release_failed", {
        claimId: input.queueMessage.claimId,
        organizationId: input.queueMessage.organizationId,
        error: extractErrorMessage(error),
      });
    }
  }

  return "retrying";
}

export async function deleteMessageFromQueue(input: {
  sqsClient: QueueSqsClient;
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

async function moveMessageToDlq(
  input: {
    config: QueueDispositionConfig;
    sqsClient: QueueSqsClient;
    sqsMessage: Message;
    reason: string;
    retryable: boolean;
    receiveCount: number;
    queueMessage: ClaimIngestQueueMessage | null;
  },
  dependencies: {
    logErrorFn: (event: string, context: Record<string, unknown>) => void;
    nowFn?: () => Date;
  },
): Promise<boolean> {
  if (!input.config.dlqUrl) {
    return false;
  }

  try {
    await input.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: input.config.dlqUrl,
        MessageBody: JSON.stringify({
          failedAt: (dependencies.nowFn ?? (() => new Date()))().toISOString(),
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
            StringValue: truncateString(input.reason, 256),
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
    dependencies.logErrorFn("queue_dlq_publish_failed", {
      error: extractErrorMessage(error),
      reason: input.reason,
      originalMessageId: input.sqsMessage.MessageId ?? null,
    });
    return false;
  }
}
