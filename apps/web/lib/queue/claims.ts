import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  buildClaimIngestQueueMessage,
  type ClaimIngestQueueSendInput,
  type ClaimIngestQueueSendResult,
  normalizeClaimIngestQueueDelaySeconds,
} from "@claimflow/db";
import { randomUUID } from "node:crypto";
import { extractErrorMessage } from "@/lib/observability/log";

type ClaimQueueEnqueueInput = {
  claimId: string;
  organizationId: string;
  inboundMessageId: string;
  providerMessageId: string;
  processingAttempt: number;
  processingLeaseToken: string;
  delaySeconds?: number;
  messageId?: string;
  queueUrl?: string;
  enqueuedAt?: Date;
};

export type ClaimQueueEnqueueResult =
  | {
      enqueued: true;
      queueUrl: string;
      messageId: string;
      sqsMessageId?: string | null;
    }
  | {
      enqueued: false;
      reason: "queue_not_configured" | "send_failed";
      queueUrl?: string;
      error?: string;
    };

let sqsClientSingleton: SQSClient | undefined;

export async function enqueueClaimIngestJob(
  input: ClaimQueueEnqueueInput,
): Promise<ClaimQueueEnqueueResult> {
  const queueUrl = input.queueUrl ?? resolveClaimIngestQueueUrl();
  if (!queueUrl) {
    return {
      enqueued: false,
      reason: "queue_not_configured",
    };
  }

  const messageId = normalizeMessageId(input.messageId);
  const sendResult = await sendClaimIngestQueueMessage({
    queueUrl,
    message: buildClaimIngestQueueMessage({
      claimId: input.claimId,
      organizationId: input.organizationId,
      inboundMessageId: input.inboundMessageId,
      providerMessageId: input.providerMessageId,
      enqueuedAt: input.enqueuedAt ?? new Date(),
      processingAttempt: input.processingAttempt,
      processingLeaseToken: input.processingLeaseToken,
    }),
    delaySeconds: input.delaySeconds,
  });

  if (!sendResult.ok) {
    return {
      enqueued: false,
      reason: "send_failed",
      queueUrl,
      error: sendResult.error,
    };
  }

  return {
    enqueued: true,
    queueUrl,
    messageId,
    sqsMessageId: sendResult.sqsMessageId ?? null,
  };
}

export function resolveClaimIngestQueueUrl(): string | null {
  const queueUrl = process.env.CLAIMS_INGEST_QUEUE_URL?.trim();
  return queueUrl ? queueUrl : null;
}

export async function sendClaimIngestQueueMessage(
  input: ClaimIngestQueueSendInput,
): Promise<ClaimIngestQueueSendResult> {
  try {
    const response = await getSqsClient().send(
      new SendMessageCommand({
        QueueUrl: input.queueUrl,
        MessageBody: JSON.stringify(input.message),
        DelaySeconds: normalizeClaimIngestQueueDelaySeconds(input.delaySeconds),
      }),
    );

    return {
      ok: true,
      sqsMessageId: typeof response.MessageId === "string" ? response.MessageId : null,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: extractErrorMessage(error, "Unknown SQS send error."),
    };
  }
}

function normalizeMessageId(value: string | undefined): string {
  const messageId = value?.trim();
  return messageId && messageId.length > 0 ? messageId : randomUUID();
}

function getSqsClient(): SQSClient {
  if (sqsClientSingleton) {
    return sqsClientSingleton;
  }

  const region = process.env.AWS_REGION?.trim();
  if (!region) {
    throw new Error("AWS_REGION is required when using SQS.");
  }

  sqsClientSingleton = new SQSClient({ region });
  return sqsClientSingleton;
}
