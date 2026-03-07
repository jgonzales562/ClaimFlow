import { prisma, transitionClaimStatusIfCurrent } from "@claimflow/db";
import { enqueueClaimIngestJob } from "@/lib/queue/claims";
import { parseWorkerFailureEvent } from "./worker-failure";

const MANUAL_RETRY_DELAY_SECONDS = 2;

type RetryErroredClaimDependencies = {
  prismaClient?: typeof prisma;
  enqueueClaimIngestJobFn?: typeof enqueueClaimIngestJob;
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

  const claim = await prismaClient.claim.findFirst({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
    },
    select: {
      id: true,
      status: true,
      inboundMessages: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          providerMessageId: true,
        },
      },
      events: {
        where: {
          eventType: "STATUS_TRANSITION",
          payload: {
            path: ["source"],
            equals: "worker_failure",
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          createdAt: true,
          payload: true,
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

  const latestFailureEvent = claim.events[0];
  const latestFailure = latestFailureEvent
    ? parseWorkerFailureEvent(latestFailureEvent.payload, latestFailureEvent.createdAt)
    : null;

  if (!latestFailure || latestFailure.retryable !== true) {
    return { kind: "retry_not_allowed" };
  }

  const latestInboundMessage = claim.inboundMessages[0];
  if (!latestInboundMessage) {
    return { kind: "retry_unavailable" };
  }

  const queueResult = await enqueueClaimIngestJobFn({
    claimId: claim.id,
    organizationId: input.organizationId,
    inboundMessageId: latestInboundMessage.id,
    providerMessageId: latestInboundMessage.providerMessageId,
    delaySeconds: MANUAL_RETRY_DELAY_SECONDS,
  });

  if (!queueResult.enqueued) {
    return queueResult.reason === "queue_not_configured"
      ? { kind: "queue_not_configured" }
      : { kind: "enqueue_failed" };
  }

  const transitioned = await prismaClient.$transaction((tx) =>
    transitionClaimStatusIfCurrent({
      tx,
      organizationId: input.organizationId,
      claimId: claim.id,
      actorUserId: input.actorUserId,
      fromStatus: "ERROR",
      toStatus: "PROCESSING",
      payload: {
        source: "manual_retry",
        inboundMessageId: latestInboundMessage.id,
        providerMessageId: latestInboundMessage.providerMessageId,
        queueMessageId: queueResult.messageId,
      },
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
    },
  });

  if (currentClaim?.status === "PROCESSING") {
    return {
      kind: "retried",
      claimId: claim.id,
    };
  }

  return { kind: "retry_not_allowed" };
}
