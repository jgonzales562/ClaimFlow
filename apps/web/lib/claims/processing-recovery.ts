import { prisma, recordProcessingRecoveryIfStale } from "@claimflow/db";
import { randomUUID } from "node:crypto";
import { enqueueClaimIngestJob } from "@/lib/queue/claims";
import { getClaimProcessingStaleBefore, getClaimProcessingStaleMinutes } from "./processing-health";

const MANUAL_PROCESSING_RECOVERY_DELAY_SECONDS = 2;

type RecoverStaleProcessingClaimDependencies = {
  prismaClient?: typeof prisma;
  enqueueClaimIngestJobFn?: typeof enqueueClaimIngestJob;
  createProcessingLeaseTokenFn?: () => string;
  nowFn?: () => Date;
  staleMinutes?: number;
};

export async function recoverStaleProcessingClaim(
  input: {
    organizationId: string;
    actorUserId: string;
    claimId: string;
  },
  dependencies: RecoverStaleProcessingClaimDependencies = {},
): Promise<
  | { kind: "claim_not_found" }
  | { kind: "recovery_not_allowed" }
  | { kind: "recovery_unavailable" }
  | { kind: "queue_not_configured" }
  | { kind: "enqueue_failed" }
  | { kind: "recovered"; claimId: string }
> {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const enqueueClaimIngestJobFn = dependencies.enqueueClaimIngestJobFn ?? enqueueClaimIngestJob;
  const createProcessingLeaseTokenFn =
    dependencies.createProcessingLeaseTokenFn ?? defaultCreateProcessingLeaseToken;
  const now = (dependencies.nowFn ?? (() => new Date()))();
  const staleMinutes = dependencies.staleMinutes ?? getClaimProcessingStaleMinutes();
  const staleBefore = getClaimProcessingStaleBefore(now, staleMinutes);

  const claim = await prismaClient.claim.findFirst({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
    },
    select: {
      id: true,
      status: true,
      updatedAt: true,
      processingAttempt: true,
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

  if (claim.status !== "PROCESSING" || claim.updatedAt.getTime() > staleBefore.getTime()) {
    return { kind: "recovery_not_allowed" };
  }

  const latestInboundMessage = claim.inboundMessages[0];
  if (!latestInboundMessage) {
    return { kind: "recovery_unavailable" };
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
    delaySeconds: MANUAL_PROCESSING_RECOVERY_DELAY_SECONDS,
  });

  if (!queueResult.enqueued) {
    return queueResult.reason === "queue_not_configured"
      ? { kind: "queue_not_configured" }
      : { kind: "enqueue_failed" };
  }

  const recovered = await prismaClient.$transaction(async (tx) => {
    return recordProcessingRecoveryIfStale({
      tx,
      organizationId: input.organizationId,
      claimId: claim.id,
      actorUserId: input.actorUserId,
      source: "manual_processing_recovery",
      staleBefore,
      touchedAt: now,
      queueMessageId: queueResult.messageId,
      inboundMessageId: latestInboundMessage.id,
      providerMessageId: latestInboundMessage.providerMessageId,
      expectedProcessingAttempt: claim.processingAttempt,
      processingLeaseToken,
      staleMinutes,
      previousUpdatedAt: claim.updatedAt.toISOString(),
    });
  });

  if (recovered === null) {
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
        kind: "recovered",
        claimId: claim.id,
      };
    }

    return { kind: "recovery_not_allowed" };
  }

  return {
    kind: "recovered",
    claimId: claim.id,
  };
}

function defaultCreateProcessingLeaseToken(): string {
  return randomUUID();
}
