import { SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  CLAIM_PROCESSING_RECOVERY_SOURCES,
  createClaimIngestQueueOutboxEntry,
  dispatchClaimIngestQueueOutboxById,
  getClaimIngestQueueAvailableAt,
  recordProcessingRecoveryIfStale,
  type ClaimIngestQueueSendResult,
} from "@claimflow/db";
import type { PrismaClient } from "@prisma/client";
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
    select: {
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
    },
  });

  if (staleClaims.length === 0) {
    return {
      scannedCount: 0,
      recoveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
  }

  const result: ProcessingWatchdogResult = {
    scannedCount: staleClaims.length,
    recoveredCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  for (const claim of staleClaims) {
    const latestInboundMessage = claim.inboundMessages[0];
    if (!latestInboundMessage) {
      result.skippedCount += 1;
      logErrorFn("processing_watchdog_missing_inbound_message", {
        claimId: claim.id,
        organizationId: claim.organizationId,
      });
      continue;
    }

    try {
      const queueMessageId = createQueueMessageIdFn();
      const processingLeaseToken = createProcessingLeaseTokenFn();
      const availableAt = getClaimIngestQueueAvailableAt(now, WATCHDOG_RECOVERY_DELAY_SECONDS);

      const recovered = await input.prismaClient.$transaction(async (tx) => {
        const recoveryAttempt = await recordProcessingRecoveryIfStale({
          tx,
          organizationId: claim.organizationId,
          claimId: claim.id,
          source: CLAIM_PROCESSING_RECOVERY_SOURCES.watchdogProcessingRecovery,
          staleBefore,
          touchedAt: now,
          queueMessageId: queueMessageId,
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

      if (recovered) {
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
            nowFn: () => now,
          },
        );

        result.recoveredCount += 1;
        logInfoFn("processing_watchdog_recovered", {
          claimId: claim.id,
          organizationId: claim.organizationId,
          previousProcessingAttempt: claim.processingAttempt,
          nextProcessingAttempt: claim.processingAttempt + 1,
          queueMessageId: queueMessageId,
          inboundMessageId: latestInboundMessage.id,
          providerMessageId: latestInboundMessage.providerMessageId,
        });

        if (dispatchResult.kind === "send_failed") {
          logErrorFn("processing_watchdog_dispatch_deferred", {
            claimId: claim.id,
            organizationId: claim.organizationId,
            queueMessageId: queueMessageId,
            error: dispatchResult.error,
          });
        }

        if (dispatchResult.kind === "dispatched" && !dispatchResult.persisted) {
          logErrorFn("processing_watchdog_dispatch_state_unconfirmed", {
            claimId: claim.id,
            organizationId: claim.organizationId,
            queueMessageId: queueMessageId,
          });
        }
      } else {
        result.skippedCount += 1;
        logInfoFn("processing_watchdog_recovery_skipped", {
          claimId: claim.id,
          organizationId: claim.organizationId,
          previousProcessingAttempt: claim.processingAttempt,
          inboundMessageId: latestInboundMessage.id,
          providerMessageId: latestInboundMessage.providerMessageId,
        });
      }
    } catch (error: unknown) {
      result.failedCount += 1;
      logErrorFn("processing_watchdog_recovery_failed", {
        claimId: claim.id,
        organizationId: claim.organizationId,
        error: extractErrorMessage(error),
      });
    }
  }

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
