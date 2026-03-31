import {
  CLAIM_PROCESSING_RECOVERY_SOURCES,
  createClaimIngestQueueOutboxEntry,
  dispatchClaimIngestQueueOutboxById,
  getClaimIngestQueueAvailableAt,
  prisma,
  recordProcessingRecoveryIfStale,
  type ClaimIngestQueueSendResult,
} from "@claimflow/db";
import { randomUUID } from "node:crypto";
import { enqueueClaimIngestJob, resolveClaimIngestQueueUrl } from "@/lib/queue/claims";
import { getClaimProcessingStaleBefore, getClaimProcessingStaleMinutes } from "./processing-health";

const MANUAL_PROCESSING_RECOVERY_DELAY_SECONDS = 2;

type RecoverStaleProcessingClaimDependencies = {
  prismaClient?: typeof prisma;
  enqueueClaimIngestJobFn?: typeof enqueueClaimIngestJob;
  resolveQueueUrlFn?: () => string | null;
  createQueueMessageIdFn?: () => string;
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
  const resolveQueueUrlFn = dependencies.resolveQueueUrlFn ?? resolveClaimIngestQueueUrl;
  const createQueueMessageIdFn = dependencies.createQueueMessageIdFn ?? defaultCreateQueueMessageId;
  const createProcessingLeaseTokenFn =
    dependencies.createProcessingLeaseTokenFn ?? defaultCreateProcessingLeaseToken;
  const now = (dependencies.nowFn ?? (() => new Date()))();
  const staleMinutes = dependencies.staleMinutes ?? getClaimProcessingStaleMinutes();
  const staleBefore = getClaimProcessingStaleBefore(now, staleMinutes);
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

  const queueMessageId = createQueueMessageIdFn();
  const nextProcessingAttempt = claim.processingAttempt + 1;
  const processingLeaseToken = createProcessingLeaseTokenFn();
  const availableAt = getClaimIngestQueueAvailableAt(now, MANUAL_PROCESSING_RECOVERY_DELAY_SECONDS);

  const recovered = await prismaClient.$transaction(async (tx) => {
    const recoveryAttempt = await recordProcessingRecoveryIfStale({
      tx,
      organizationId: input.organizationId,
      claimId: claim.id,
      actorUserId: input.actorUserId,
      source: CLAIM_PROCESSING_RECOVERY_SOURCES.manualProcessingRecovery,
      staleBefore,
      touchedAt: now,
      queueMessageId: queueMessageId,
      inboundMessageId: latestInboundMessage.id,
      providerMessageId: latestInboundMessage.providerMessageId,
      expectedProcessingAttempt: claim.processingAttempt,
      processingLeaseToken,
      staleMinutes,
      previousUpdatedAt: claim.updatedAt.toISOString(),
    });

    if (recoveryAttempt === null) {
      return null;
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

    return recoveryAttempt;
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

  await dispatchClaimIngestQueueOutboxById(
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

  return {
    kind: "recovered",
    claimId: claim.id,
  };
}

function defaultCreateProcessingLeaseToken(): string {
  return randomUUID();
}

function defaultCreateQueueMessageId(): string {
  return randomUUID();
}
