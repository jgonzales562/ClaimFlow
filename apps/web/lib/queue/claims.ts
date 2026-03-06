import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { extractErrorMessage } from "@/lib/observability/log";

type ClaimIngestQueueMessage = {
  version: 1;
  claimId: string;
  organizationId: string;
  inboundMessageId: string;
  providerMessageId: string;
  enqueuedAt: string;
};

export type ClaimQueueEnqueueResult =
  | {
      enqueued: true;
      queueUrl: string;
      messageId: string;
    }
  | {
      enqueued: false;
      reason: "queue_not_configured" | "send_failed";
      queueUrl?: string;
      error?: string;
    };

let sqsClientSingleton: SQSClient | undefined;

export async function enqueueClaimIngestJob(
  input: Omit<ClaimIngestQueueMessage, "version" | "enqueuedAt">,
): Promise<ClaimQueueEnqueueResult> {
  const queueUrl = process.env.CLAIMS_INGEST_QUEUE_URL?.trim();
  if (!queueUrl) {
    return {
      enqueued: false,
      reason: "queue_not_configured",
    };
  }

  const message: ClaimIngestQueueMessage = {
    version: 1,
    ...input,
    enqueuedAt: new Date().toISOString(),
  };

  try {
    const response = await getSqsClient().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );

    if (!response.MessageId) {
      return {
        enqueued: false,
        reason: "send_failed",
        queueUrl,
        error: "SQS did not return a MessageId.",
      };
    }

    return {
      enqueued: true,
      queueUrl,
      messageId: response.MessageId,
    };
  } catch (error: unknown) {
    return {
      enqueued: false,
      reason: "send_failed",
      queueUrl,
      error: extractErrorMessage(error, "Unknown SQS send error."),
    };
  }
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
