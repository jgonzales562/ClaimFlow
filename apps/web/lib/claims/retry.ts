import { prisma, CLAIM_PROCESSING_START_SOURCES, startClaimProcessingAttemptIfCurrent } from "@claimflow/db";
import { randomUUID } from "node:crypto";
import { enqueueClaimIngestJob } from "@/lib/queue/claims";
import { readWorkerFailureSnapshot } from "./worker-failure";

const MANUAL_RETRY_DELAY_SECONDS = 2;

type RetryErroredClaimDependencies = {
  prismaClient?: typeof prisma;
  enqueueClaimIngestJobFn?: typeof enqueueClaimIngestJob;
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
  | { kind: "enqueue_failed" }
  | { kind: "retried"; claimId: string }
> {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const enqueueClaimIngestJobFn = dependencies.enqueueClaimIngestJobFn ?? enqueueClaimIngestJob;
  const createProcessingLeaseTokenFn =
    dependencies.createProcessingLeaseTokenFn ?? defaultCreateProcessingLeaseToken;

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

  const nextProcessingAttempt = claim.processingAttempt + 1;
  const processingLeaseToken = createProcessingLeaseTokenFn();

  const queueResult = await enqueueClaimIngestJobFn({
    claimId: claim.id,
    organizationId: input.organizationId,
    inboundMessageId: latestInboundMessage.id,
    providerMessageId: latestInboundMessage.providerMessageId,
    processingAttempt: nextProcessingAttempt,
    processingLeaseToken,
    delaySeconds: MANUAL_RETRY_DELAY_SECONDS,
  });

  if (!queueResult.enqueued) {
    return queueResult.reason === "queue_not_configured"
      ? { kind: "queue_not_configured" }
      : { kind: "enqueue_failed" };
  }

  const transitioned = await prismaClient.$transaction((tx) =>
    startClaimProcessingAttemptIfCurrent({
      tx,
      organizationId: input.organizationId,
      claimId: claim.id,
      actorUserId: input.actorUserId,
      expectedProcessingAttempt: claim.processingAttempt,
      processingLeaseToken,
      fromStatus: "ERROR",
      source: CLAIM_PROCESSING_START_SOURCES.manualRetry,
      queueMessageId: queueResult.messageId,
      inboundMessageId: latestInboundMessage.id,
      providerMessageId: latestInboundMessage.providerMessageId,
    }),
  );

  if (transitioned) {
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
