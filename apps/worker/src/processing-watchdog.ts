import { SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  CLAIM_PROCESSING_RECOVERY_SOURCES,
  createClaimIngestQueueOutboxEntry,
  dispatchClaimIngestQueueOutboxById,
  getClaimIngestQueueAvailableAt,
  recordProcessingRecoveryIfStale,
  type ClaimIngestQueueSendResult,
} from "@claimflow/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { WorkerConfig } from "./config.js";
import { extractErrorMessage } from "./errors.js";
import type { ClaimIngestQueueMessage } from "./queue-handler.js";
import type { QueueSqsClient } from "./queue-disposition.js";

const WATCHDOG_RECOVERY_DELAY_SECONDS = 2;

export type ProcessingWatchdogResult = {
  scannedCount: number;
  recoveredCount: number;
  skippedCount: number;
  failedCount: number;
};

type ProcessingWatchdogDependencies = {
  nowFn?: () => Date;
  createQueueMessageIdFn?: () => string;
  createProcessingLeaseTokenFn?: () => string;
  logInfoFn?: (event: string, context: Record<string, unknown>) => void;
  logErrorFn?: (event: string, context: Record<string, unknown>) => void;
};

const staleProcessingClaimSelect = {
  id: true,
  organizationId: true,
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
} as const satisfies Prisma.ClaimSelect;

type StaleProcessingClaim = Prisma.ClaimGetPayload<{
  select: typeof staleProcessingClaimSelect;
}>;

type ProcessingWatchdogClaimOutcome = Pick<
  ProcessingWatchdogResult,
  "recoveredCount" | "skippedCount" | "failedCount"
>;

export async function recoverStaleProcessingClaims(
  input: {
    prismaClient: PrismaClient;
    sqsClient: QueueSqsClient;
    config: WorkerConfig;
  },
  dependencies: ProcessingWatchdogDependencies = {},
): Promise<ProcessingWatchdogResult> {
  const now = (dependencies.nowFn ?? (() => new Date()))();
  const staleBefore = new Date(
    now.getTime() - input.config.processingStaleMinutes * 60_000,
  );
  const createQueueMessageIdFn =
    dependencies.createQueueMessageIdFn ?? defaultCreateQueueMessageId;
  const createProcessingLeaseTokenFn =
    dependencies.createProcessingLeaseTokenFn ?? defaultCreateProcessingLeaseToken;
  const logInfoFn = dependencies.logInfoFn ?? (() => {});
  const logErrorFn = dependencies.logErrorFn ?? (() => {});

  const staleClaims = await input.prismaClient.claim.findMany({
    where: {
      status: "PROCESSING",
      updatedAt: {
        lte: staleBefore,
      },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: input.config.processingWatchdogBatchSize,
    select: staleProcessingClaimSelect,
  });

  if (staleClaims.length === 0) {
    return {
      scannedCount: 0,
      recoveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
  }

  const claimResults = await mapWithConcurrency(
    staleClaims,
    input.config.processingWatchdogConcurrency,
    async (claim) =>
      recoverSingleStaleProcessingClaim(
        claim,
        {
          prismaClient: input.prismaClient,
          sqsClient: input.sqsClient,
          config: input.config,
          now,
          staleBefore,
        },
        {
          createQueueMessageIdFn,
          createProcessingLeaseTokenFn,
          logInfoFn,
          logErrorFn,
        },
      ),
  );

  const result = claimResults.reduce<ProcessingWatchdogResult>(
    (accumulator, claimResult) => {
      accumulator.recoveredCount += claimResult.recoveredCount;
      accumulator.skippedCount += claimResult.skippedCount;
      accumulator.failedCount += claimResult.failedCount;
      return accumulator;
    },
    {
      scannedCount: staleClaims.length,
      recoveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
    },
  );

  logInfoFn("processing_watchdog_completed", {
    scannedCount: result.scannedCount,
    recoveredCount: result.recoveredCount,
    skippedCount: result.skippedCount,
    failedCount: result.failedCount,
  });

  return result;
}

function defaultCreateProcessingLeaseToken(): string {
  return randomUUID();
}

function defaultCreateQueueMessageId(): string {
  return randomUUID();
}

async function recoverSingleStaleProcessingClaim(
  claim: StaleProcessingClaim,
  input: {
    prismaClient: PrismaClient;
    sqsClient: QueueSqsClient;
    config: WorkerConfig;
    now: Date;
    staleBefore: Date;
  },
  dependencies: Required<Pick<
    ProcessingWatchdogDependencies,
    "createQueueMessageIdFn" | "createProcessingLeaseTokenFn" | "logInfoFn" | "logErrorFn"
  >>,
): Promise<ProcessingWatchdogClaimOutcome> {
  const latestInboundMessage = claim.inboundMessages[0];
  if (!latestInboundMessage) {
    dependencies.logErrorFn("processing_watchdog_missing_inbound_message", {
      claimId: claim.id,
      organizationId: claim.organizationId,
    });
    return {
      recoveredCount: 0,
      skippedCount: 1,
      failedCount: 0,
    };
  }

  try {
    const queueMessageId = dependencies.createQueueMessageIdFn();
    const processingLeaseToken = dependencies.createProcessingLeaseTokenFn();
    const availableAt = getClaimIngestQueueAvailableAt(input.now, WATCHDOG_RECOVERY_DELAY_SECONDS);

    const recovered = await input.prismaClient.$transaction(async (tx) => {
      const recoveryAttempt = await recordProcessingRecoveryIfStale({
        tx,
        organizationId: claim.organizationId,
        claimId: claim.id,
        source: CLAIM_PROCESSING_RECOVERY_SOURCES.watchdogProcessingRecovery,
        staleBefore: input.staleBefore,
        touchedAt: input.now,
        queueMessageId,
        inboundMessageId: latestInboundMessage.id,
        providerMessageId: latestInboundMessage.providerMessageId,
        expectedProcessingAttempt: claim.processingAttempt,
        processingLeaseToken,
        staleMinutes: input.config.processingStaleMinutes,
        previousUpdatedAt: claim.updatedAt.toISOString(),
      });

      if (recoveryAttempt === null) {
        return null;
      }

      await createClaimIngestQueueOutboxEntry({
        tx,
        id: queueMessageId,
        organizationId: claim.organizationId,
        claimId: claim.id,
        inboundMessageId: latestInboundMessage.id,
        providerMessageId: latestInboundMessage.providerMessageId,
        queueUrl: input.config.queueUrl,
        processingAttempt: claim.processingAttempt + 1,
        processingLeaseToken,
        availableAt,
      });

      return recoveryAttempt;
    });

    if (!recovered) {
      dependencies.logInfoFn("processing_watchdog_recovery_skipped", {
        claimId: claim.id,
        organizationId: claim.organizationId,
        previousProcessingAttempt: claim.processingAttempt,
        inboundMessageId: latestInboundMessage.id,
        providerMessageId: latestInboundMessage.providerMessageId,
      });
      return {
        recoveredCount: 0,
        skippedCount: 1,
        failedCount: 0,
      };
    }

    const dispatchResult = await dispatchClaimIngestQueueOutboxById(
      {
        prismaClient: input.prismaClient,
        outboxId: queueMessageId,
        sendMessageFn: async (dispatchInput): Promise<ClaimIngestQueueSendResult> => {
          try {
            const response = await input.sqsClient.send(
              new SendMessageCommand({
                QueueUrl: dispatchInput.queueUrl,
                MessageBody: JSON.stringify(
                  dispatchInput.message satisfies ClaimIngestQueueMessage,
                ),
                DelaySeconds: dispatchInput.delaySeconds,
              }),
            );

            return {
              ok: true,
              sqsMessageId:
                typeof response === "object" &&
                response !== null &&
                "MessageId" in response &&
                typeof (response as { MessageId?: unknown }).MessageId === "string"
                  ? (response as { MessageId: string }).MessageId
                  : null,
            };
          } catch (error: unknown) {
            return {
              ok: false,
              error: extractErrorMessage(error),
            };
          }
        },
      },
      {
        nowFn: () => input.now,
      },
    );

    dependencies.logInfoFn("processing_watchdog_recovered", {
      claimId: claim.id,
      organizationId: claim.organizationId,
      previousProcessingAttempt: claim.processingAttempt,
      nextProcessingAttempt: claim.processingAttempt + 1,
      queueMessageId,
      inboundMessageId: latestInboundMessage.id,
      providerMessageId: latestInboundMessage.providerMessageId,
    });

    if (dispatchResult.kind === "send_failed") {
      dependencies.logErrorFn("processing_watchdog_dispatch_deferred", {
        claimId: claim.id,
        organizationId: claim.organizationId,
        queueMessageId,
        error: dispatchResult.error,
      });
    }

    if (dispatchResult.kind === "dispatched" && !dispatchResult.persisted) {
      dependencies.logErrorFn("processing_watchdog_dispatch_state_unconfirmed", {
        claimId: claim.id,
        organizationId: claim.organizationId,
        queueMessageId,
      });
    }

    return {
      recoveredCount: 1,
      skippedCount: 0,
      failedCount: 0,
    };
  } catch (error: unknown) {
    dependencies.logErrorFn("processing_watchdog_recovery_failed", {
      claimId: claim.id,
      organizationId: claim.organizationId,
      error: extractErrorMessage(error),
    });
    return {
      recoveredCount: 0,
      skippedCount: 0,
      failedCount: 1,
    };
  }
}

async function mapWithConcurrency<TInput, TResult>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.floor(concurrency));
  const workerCount = Math.min(safeConcurrency, items.length);
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) {
        return;
      }

      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}
