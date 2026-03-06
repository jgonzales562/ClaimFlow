import { prisma, transitionClaimStatusIfCurrent } from "@claimflow/db";

type ClaimIngestEnqueueInput = {
  organizationId: string;
  claimId: string | null;
  inboundMessageId: string;
  providerMessageId: string;
  shouldEnqueue: boolean;
};

type ClaimQueueEnqueueInput = Omit<ClaimIngestEnqueueInput, "shouldEnqueue" | "claimId"> & {
  claimId: string;
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
  const claimId = input.claimId;

  const queueResult = await enqueueClaimIngestJobFn({
    claimId,
    organizationId: input.organizationId,
    inboundMessageId: input.inboundMessageId,
    providerMessageId: input.providerMessageId,
  });

  if (queueResult.enqueued) {
    await prismaClient.$transaction(async (tx) => {
      await transitionClaimStatusIfCurrent({
        tx,
        organizationId: input.organizationId,
        claimId,
        fromStatus: "NEW",
        toStatus: "PROCESSING",
        payload: {
          source: "webhook_enqueue",
          inboundMessageId: input.inboundMessageId,
          providerMessageId: input.providerMessageId,
          queueMessageId: queueResult.messageId,
        },
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
