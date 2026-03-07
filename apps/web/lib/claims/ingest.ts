import { prisma, startClaimProcessingAttemptIfCurrent } from "@claimflow/db";
import { randomUUID } from "node:crypto";

type ClaimIngestEnqueueInput = {
  organizationId: string;
  claimId: string | null;
  inboundMessageId: string;
  providerMessageId: string;
  shouldEnqueue: boolean;
};

type ClaimQueueEnqueueInput = Omit<ClaimIngestEnqueueInput, "shouldEnqueue" | "claimId"> & {
  claimId: string;
  processingAttempt?: number;
  processingLeaseToken?: string;
};

type ClaimQueueEnqueueFn = (
  input: ClaimQueueEnqueueInput,
) => Promise<ClaimQueueEnqueueResult>;

type ClaimQueueEnqueueResult =
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

type ClaimIngestEnqueueDependencies = {
  prismaClient?: typeof prisma;
  enqueueClaimIngestJobFn?: ClaimQueueEnqueueFn;
  createProcessingLeaseTokenFn?: () => string;
};

export async function maybeEnqueueClaimForProcessing(
  input: ClaimIngestEnqueueInput,
  dependencies: ClaimIngestEnqueueDependencies = {},
): Promise<ClaimQueueEnqueueResult | null> {
  if (!input.claimId || !input.shouldEnqueue) {
    return null;
  }

  const prismaClient = dependencies.prismaClient ?? prisma;
  const enqueueClaimIngestJobFn =
    dependencies.enqueueClaimIngestJobFn ?? defaultEnqueueClaimIngestJob;
  const createProcessingLeaseTokenFn =
    dependencies.createProcessingLeaseTokenFn ?? defaultCreateProcessingLeaseToken;
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

  const nextProcessingAttempt =
    claim.status === "NEW" ? claim.processingAttempt + 1 : undefined;
  const processingLeaseToken =
    typeof nextProcessingAttempt === "number" ? createProcessingLeaseTokenFn() : undefined;

  const queueResult = await enqueueClaimIngestJobFn({
    claimId,
    organizationId: input.organizationId,
    inboundMessageId: input.inboundMessageId,
    providerMessageId: input.providerMessageId,
    processingAttempt: nextProcessingAttempt,
    processingLeaseToken,
  });

  if (queueResult.enqueued && claim.status === "NEW") {
    await prismaClient.$transaction(async (tx) => {
      await startClaimProcessingAttemptIfCurrent({
        tx,
        organizationId: input.organizationId,
        claimId,
        expectedProcessingAttempt: claim.processingAttempt,
        processingLeaseToken: processingLeaseToken ?? queueResult.messageId,
        fromStatus: "NEW",
        source: "webhook_enqueue",
        queueMessageId: queueResult.messageId,
        inboundMessageId: input.inboundMessageId,
        providerMessageId: input.providerMessageId,
      });
    });
  }

  return queueResult;
}

async function defaultEnqueueClaimIngestJob(
  input: ClaimQueueEnqueueInput,
): Promise<ClaimQueueEnqueueResult> {
  const { enqueueClaimIngestJob } = await import("../queue/claims");
  return enqueueClaimIngestJob(input);
}

function defaultCreateProcessingLeaseToken(): string {
  return randomUUID();
}
