import {
  CLAIM_PROCESSING_START_SOURCES,
  createClaimIngestQueueOutboxEntry,
  dispatchClaimIngestQueueOutboxById,
  getClaimIngestQueueAvailableAt,
  prisma,
  startClaimProcessingAttemptIfCurrent,
  type ClaimIngestQueueSendResult,
} from "@claimflow/db";
import { randomUUID } from "node:crypto";
import { enqueueClaimIngestJob, resolveClaimIngestQueueUrl } from "@/lib/queue/claims";
import { readWorkerFailureSnapshot } from "./worker-failure";

const MANUAL_RETRY_DELAY_SECONDS = 2;

type RetryErroredClaimDependencies = {
  prismaClient?: typeof prisma;
  enqueueClaimIngestJobFn?: typeof enqueueClaimIngestJob;
  resolveQueueUrlFn?: () => string | null;
  createQueueMessageIdFn?: () => string;
  createProcessingLeaseTokenFn?: () => string;
};

export async function retryErroredClaim(
  input: {
    organizationId: string;
    actorUserId: string;
    claimId: string;
  },
  dependencies: RetryErroredClaimDependencies = {},
): Promise<
  | { kind: "claim_not_found" }
  | { kind: "retry_not_allowed" }
  | { kind: "retry_unavailable" }
  | { kind: "queue_not_configured" }
  | { kind: "retried"; claimId: string }
> {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const enqueueClaimIngestJobFn = dependencies.enqueueClaimIngestJobFn ?? enqueueClaimIngestJob;
  const resolveQueueUrlFn = dependencies.resolveQueueUrlFn ?? resolveClaimIngestQueueUrl;
  const createQueueMessageIdFn = dependencies.createQueueMessageIdFn ?? defaultCreateQueueMessageId;
  const createProcessingLeaseTokenFn =
    dependencies.createProcessingLeaseTokenFn ?? defaultCreateProcessingLeaseToken;
  const queueUrl = resolveQueueUrlFn();
  if (!queueUrl) {
    return { kind: "queue_not_configured" };
  }

  const claim = await prismaClient.claim.findFirst({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
    },
    select: {
      id: true,
      status: true,
      processingAttempt: true,
      latestWorkerFailureAt: true,
      latestWorkerFailureReason: true,
      latestWorkerFailureRetryable: true,
      latestWorkerFailureReceiveCount: true,
      latestWorkerFailureDisposition: true,
      inboundMessages: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          providerMessageId: true,
        },
      },
    },
  });

  if (!claim) {
    return { kind: "claim_not_found" };
  }

  if (claim.status !== "ERROR") {
    return { kind: "retry_not_allowed" };
  }

  const latestFailure = readWorkerFailureSnapshot(claim);

  if (!latestFailure || latestFailure.retryable !== true) {
    return { kind: "retry_not_allowed" };
  }

  const latestInboundMessage = claim.inboundMessages[0];
  if (!latestInboundMessage) {
    return { kind: "retry_unavailable" };
  }

  const queueMessageId = createQueueMessageIdFn();
  const nextProcessingAttempt = claim.processingAttempt + 1;
  const processingLeaseToken = createProcessingLeaseTokenFn();
  const now = new Date();
  const availableAt = getClaimIngestQueueAvailableAt(now, MANUAL_RETRY_DELAY_SECONDS);

  const transitioned = await prismaClient.$transaction(async (tx) => {
    const startedAttempt = await startClaimProcessingAttemptIfCurrent({
      tx,
      organizationId: input.organizationId,
      claimId: claim.id,
      actorUserId: input.actorUserId,
      expectedProcessingAttempt: claim.processingAttempt,
      processingLeaseToken,
      fromStatus: "ERROR",
      source: CLAIM_PROCESSING_START_SOURCES.manualRetry,
      queueMessageId: queueMessageId,
      inboundMessageId: latestInboundMessage.id,
      providerMessageId: latestInboundMessage.providerMessageId,
    });

    if (startedAttempt === null) {
      return false;
    }

    await createClaimIngestQueueOutboxEntry({
      tx,
      id: queueMessageId,
      organizationId: input.organizationId,
      claimId: claim.id,
      inboundMessageId: latestInboundMessage.id,
      providerMessageId: latestInboundMessage.providerMessageId,
      queueUrl,
      processingAttempt: nextProcessingAttempt,
      processingLeaseToken,
      availableAt,
    });

    return true;
  });

  if (transitioned) {
    const dispatchResult = await dispatchClaimIngestQueueOutboxById(
      {
        prismaClient,
        outboxId: queueMessageId,
        sendMessageFn: async (dispatchInput): Promise<ClaimIngestQueueSendResult> => {
          const queueResult = await enqueueClaimIngestJobFn({
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

          return queueResult.enqueued
            ? {
                ok: true,
                sqsMessageId: queueResult.sqsMessageId ?? null,
              }
            : {
                ok: false,
                error: queueResult.error ?? "Unknown queue dispatch failure.",
              };
        },
      },
      {
        nowFn: () => now,
      },
    );

    if (dispatchResult.kind === "not_found") {
      throw new Error(`Claim ingest outbox row "${queueMessageId}" disappeared before dispatch.`);
    }

    return {
      kind: "retried",
      claimId: claim.id,
    };
  }

  const currentClaim = await prismaClient.claim.findFirst({
    where: {
      id: claim.id,
      organizationId: input.organizationId,
    },
    select: {
      status: true,
      processingAttempt: true,
    },
  });

  if (
    currentClaim?.status === "PROCESSING" &&
    currentClaim.processingAttempt >= nextProcessingAttempt
  ) {
    return {
      kind: "retried",
      claimId: claim.id,
    };
  }

  return { kind: "retry_not_allowed" };
}

function defaultCreateProcessingLeaseToken(): string {
  return randomUUID();
}

function defaultCreateQueueMessageId(): string {
  return randomUUID();
}
