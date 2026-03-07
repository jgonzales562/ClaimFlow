import type { ClaimStatus, Prisma } from "@prisma/client";
import { recordClaimStatusTransition } from "./claim-status.js";

export type ClaimProcessingRecoverySource =
  | "manual_processing_recovery"
  | "watchdog_processing_recovery";

export type ClaimProcessingStartSource = "webhook_enqueue" | "manual_retry";

export async function startClaimProcessingAttemptIfCurrent(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  claimId: string;
  fromStatus: ClaimStatus;
  actorUserId?: string | null;
  source: ClaimProcessingStartSource;
  expectedProcessingAttempt: number;
  processingLeaseToken: string;
  queueMessageId: string;
  inboundMessageId: string;
  providerMessageId: string;
}): Promise<number | null> {
  const nextProcessingAttempt = input.expectedProcessingAttempt + 1;

  const transition = await input.tx.claim.updateMany({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
      status: input.fromStatus,
      processingAttempt: input.expectedProcessingAttempt,
    },
    data: {
      status: "PROCESSING",
      processingAttempt: {
        increment: 1,
      },
      processingLeaseToken: input.processingLeaseToken,
      processingLeaseClaimedAt: null,
    },
  });

  if (transition.count !== 1) {
    return null;
  }

  await recordClaimStatusTransition({
    tx: input.tx,
    organizationId: input.organizationId,
    claimId: input.claimId,
    actorUserId: input.actorUserId ?? null,
    fromStatus: input.fromStatus,
    toStatus: "PROCESSING",
    payload: {
      source: input.source,
      queueMessageId: input.queueMessageId,
      inboundMessageId: input.inboundMessageId,
      providerMessageId: input.providerMessageId,
    },
  });

  return nextProcessingAttempt;
}

export async function recordProcessingRecoveryIfStale(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  claimId: string;
  actorUserId?: string | null;
  source: ClaimProcessingRecoverySource;
  staleBefore: Date;
  touchedAt: Date;
  queueMessageId: string;
  inboundMessageId: string;
  providerMessageId: string;
  expectedProcessingAttempt: number;
  processingLeaseToken: string;
  staleMinutes: number;
  previousUpdatedAt: string;
}): Promise<number | null> {
  const nextProcessingAttempt = input.expectedProcessingAttempt + 1;

  const touchedClaim = await input.tx.claim.updateMany({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
      status: "PROCESSING",
      processingAttempt: input.expectedProcessingAttempt,
      updatedAt: {
        lte: input.staleBefore,
      },
    },
    data: {
      updatedAt: input.touchedAt,
      processingAttempt: {
        increment: 1,
      },
      processingLeaseToken: input.processingLeaseToken,
      processingLeaseClaimedAt: null,
    },
  });

  if (touchedClaim.count !== 1) {
    return null;
  }

  await recordClaimStatusTransition({
    tx: input.tx,
    organizationId: input.organizationId,
    claimId: input.claimId,
    actorUserId: input.actorUserId ?? null,
    fromStatus: "PROCESSING",
    toStatus: "PROCESSING",
    payload: {
      source: input.source,
      queueMessageId: input.queueMessageId,
      inboundMessageId: input.inboundMessageId,
      providerMessageId: input.providerMessageId,
      staleMinutes: input.staleMinutes,
      previousUpdatedAt: input.previousUpdatedAt,
    },
  });

  return nextProcessingAttempt;
}
