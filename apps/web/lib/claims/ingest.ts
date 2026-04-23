import {
  createClaimIngestQueueOutboxEntry,
  dispatchClaimIngestQueueOutboxById,
  getClaimIngestQueueAvailableAt,
  prisma,
  startClaimProcessingAttemptIfCurrent,
  type ClaimIngestQueueSendResult,
} from "@claimflow/db";
import { randomUUID } from "node:crypto";
import {
  enqueueClaimIngestJob,
  resolveClaimIngestQueueUrl,
  type ClaimQueueEnqueueResult as QueueDispatchResult,
} from "../queue/claims";

type ClaimIngestEnqueueInput = {
  organizationId: string;
  claimId: string | null;
  inboundMessageId: string;
  providerMessageId: string;
  shouldEnqueue: boolean;
};

type ClaimQueueEnqueueInput = Omit<ClaimIngestEnqueueInput, "shouldEnqueue" | "claimId"> & {
  claimId: string;
  processingAttempt: number;
  processingLeaseToken: string;
  delaySeconds?: number;
  messageId?: string;
  queueUrl?: string;
  enqueuedAt?: Date;
};

type ClaimQueueEnqueueFn = (
  input: ClaimQueueEnqueueInput,
) => Promise<QueueDispatchResult>;

export type ClaimProcessingScheduleResult =
  | {
      scheduled: true;
      queueUrl: string;
      messageId: string;
      dispatchState: "dispatched" | "deferred";
      sqsMessageId: string | null;
      error: string | null;
    }
  | {
      reason: "queue_not_configured";
    };

type ClaimIngestEnqueueDependencies = {
  prismaClient?: typeof prisma;
  enqueueClaimIngestJobFn?: ClaimQueueEnqueueFn;
  resolveQueueUrlFn?: () => string | null;
  createQueueMessageIdFn?: () => string;
  createProcessingLeaseTokenFn?: () => string;
};

export async function maybeEnqueueClaimForProcessing(
  input: ClaimIngestEnqueueInput,
  dependencies: ClaimIngestEnqueueDependencies = {},
): Promise<ClaimProcessingScheduleResult | null> {
  if (!input.claimId || !input.shouldEnqueue) {
    return null;
  }

  const prismaClient = dependencies.prismaClient ?? prisma;
  const enqueueClaimIngestJobFn = dependencies.enqueueClaimIngestJobFn ?? enqueueClaimIngestJob;
  const resolveQueueUrlFn = dependencies.resolveQueueUrlFn ?? resolveClaimIngestQueueUrl;
  const createQueueMessageIdFn = dependencies.createQueueMessageIdFn ?? defaultCreateQueueMessageId;
  const createProcessingLeaseTokenFn =
    dependencies.createProcessingLeaseTokenFn ?? defaultCreateProcessingLeaseToken;
  const queueUrl = resolveQueueUrlFn();
  if (!queueUrl) {
    return {
      reason: "queue_not_configured",
    };
  }
  const claimId = input.claimId;
  const claim = await prismaClient.claim.findFirst({
    where: {
      id: claimId,
      organizationId: input.organizationId,
    },
    select: {
      status: true,
      processingAttempt: true,
    },
  });

  if (!claim) {
    return null;
  }

  if (claim.status !== "NEW") {
    return null;
  }

  const queueMessageId = createQueueMessageIdFn();
  const nextProcessingAttempt = claim.processingAttempt + 1;
  const processingLeaseToken = createProcessingLeaseTokenFn();
  const availableAt = getClaimIngestQueueAvailableAt(new Date());
  const scheduled = await prismaClient.$transaction(async (tx) => {
    const startedAttempt = await startClaimProcessingAttemptIfCurrent({
      tx,
      organizationId: input.organizationId,
      claimId,
      expectedProcessingAttempt: claim.processingAttempt,
      processingLeaseToken,
      fromStatus: "NEW",
      source: "webhook_enqueue",
      queueMessageId: queueMessageId,
      inboundMessageId: input.inboundMessageId,
      providerMessageId: input.providerMessageId,
    });

    if (startedAttempt === null) {
      return false;
    }

    await createClaimIngestQueueOutboxEntry({
      tx,
      id: queueMessageId,
      organizationId: input.organizationId,
      claimId,
      inboundMessageId: input.inboundMessageId,
      providerMessageId: input.providerMessageId,
      queueUrl,
      processingAttempt: nextProcessingAttempt,
      processingLeaseToken,
      availableAt,
    });

    return true;
  });

  if (!scheduled) {
    return null;
  }

  const dispatchResult = await dispatchClaimIngestQueueOutboxById(
    {
      prismaClient,
      outboxId: queueMessageId,
      sendMessageFn: async (dispatchInput): Promise<ClaimIngestQueueSendResult> => {
        const dispatchResult = await enqueueClaimIngestJobFn({
          claimId: dispatchInput.message.claimId,
          organizationId: dispatchInput.message.organizationId,
          inboundMessageId: dispatchInput.message.inboundMessageId,
          providerMessageId: dispatchInput.message.providerMessageId,
          processingAttempt: dispatchInput.message.processingAttempt,
          processingLeaseToken: dispatchInput.message.processingLeaseToken,
          delaySeconds: dispatchInput.delaySeconds,
          messageId: queueMessageId,
          queueUrl: dispatchInput.queueUrl,
          enqueuedAt: new Date(dispatchInput.message.enqueuedAt),
        });

        return dispatchResult.enqueued
          ? {
              ok: true,
              sqsMessageId: dispatchResult.sqsMessageId ?? null,
            }
          : {
              ok: false,
              error: dispatchResult.error ?? "Unknown queue dispatch failure.",
            };
      },
    },
  );

  if (dispatchResult.kind === "not_found") {
    throw new Error(`Claim ingest outbox row "${queueMessageId}" disappeared before dispatch.`);
  }

  if (dispatchResult.kind === "dispatched") {
    return {
      scheduled: true,
      queueUrl,
      messageId: queueMessageId,
      dispatchState: "dispatched",
      sqsMessageId: dispatchResult.sqsMessageId,
      error: null,
    };
  }

  return {
    scheduled: true,
    queueUrl,
    messageId: queueMessageId,
    dispatchState: "deferred",
    sqsMessageId: null,
    error: dispatchResult.kind === "send_failed" ? dispatchResult.error : null,
  };
}

function defaultCreateProcessingLeaseToken(): string {
  return randomUUID();
}

function defaultCreateQueueMessageId(): string {
  return randomUUID();
}
