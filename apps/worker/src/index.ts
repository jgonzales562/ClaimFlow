import { markClaimAsError, releaseClaimProcessingLease } from "./claim-state.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { processClaimIngestJob } from "./ingest-job.js";
import {
  cleanupDispatchedClaimIngestQueueOutbox,
  DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_BATCH_SIZE,
  dispatchPendingClaimIngestQueueOutbox,
} from "@claimflow/db";
import {
  captureWorkerException,
  initWorkerSentry,
  isWorkerSentryEnabled,
  logError,
  logInfo,
} from "./observability.js";
import { recoverStaleProcessingClaims } from "./processing-watchdog.js";
import { handleClaimQueueMessage } from "./queue-handler.js";
import {
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Message } from "@aws-sdk/client-sqs";
import * as Sentry from "@sentry/node";
import { PrismaClient } from "@prisma/client";
import { extractErrorMessage } from "./errors.js";

const prisma = new PrismaClient();

void bootstrap();

async function bootstrap(): Promise<void> {
  let config: WorkerConfig | null = null;

  try {
    config = loadWorkerConfig();
    initWorkerSentry(config);
    process.on("uncaughtException", (error: Error) => {
      captureWorkerException(error, { stage: "uncaught_exception" });
      logError("worker_uncaught_exception", { error: extractErrorMessage(error) });
    });
    process.on("unhandledRejection", (reason: unknown) => {
      captureWorkerException(reason, { stage: "unhandled_rejection" });
      logError("worker_unhandled_rejection", { error: extractErrorMessage(reason) });
    });
    const sqsClient = new SQSClient({
      region: config.awsRegion,
    });
    await runWorkerLoop(config, sqsClient);
  } catch (error: unknown) {
    captureWorkerException(error, {
      stage: "bootstrap",
      queueUrl: config?.queueUrl ?? null,
      awsRegion: config?.awsRegion ?? null,
    });

    logError("worker_startup_failed", { error: extractErrorMessage(error) });
    process.exitCode = 1;
  } finally {
    if (isWorkerSentryEnabled()) {
      await Sentry.flush(2_000);
    }
    await prisma.$disconnect();
  }
}

async function runWorkerLoop(config: WorkerConfig, sqsClient: SQSClient): Promise<void> {
  let shuttingDown = false;
  let nextOutboxCleanupRunAt = 0;
  let nextWatchdogRunAt = 0;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo("worker_signal_received", { signal });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  logInfo("worker_started", {
    queueUrl: config.queueUrl,
    dlqUrl: config.dlqUrl,
    ingestQueueOutboxCleanupBatchSize: config.ingestQueueOutboxCleanupBatchSize,
    ingestQueueOutboxCleanupIntervalMs: config.ingestQueueOutboxCleanupIntervalMs,
    ingestQueueOutboxRetentionHours: config.ingestQueueOutboxRetentionHours,
    processingStaleMinutes: config.processingStaleMinutes,
    processingWatchdogEnabled: config.processingWatchdogEnabled,
    processingWatchdogIntervalMs: config.processingWatchdogIntervalMs,
    processingWatchdogBatchSize: config.processingWatchdogBatchSize,
    pollWaitSeconds: config.pollWaitSeconds,
    maxMessages: config.maxMessages,
    processingConcurrency: config.processingConcurrency,
    maxReceiveCount: config.maxReceiveCount,
    extractionModel: config.extractionModel,
    extractionReadyConfidence: config.extractionReadyConfidence,
    textractFallbackEnabled: config.textractFallbackEnabled,
    textractFallbackConfidenceThreshold: config.textractFallbackConfidenceThreshold,
    sentryEnabled: Boolean(config.sentryDsn),
  });

  while (!shuttingDown) {
    if (Date.now() >= nextOutboxCleanupRunAt) {
      nextOutboxCleanupRunAt = Date.now() + config.ingestQueueOutboxCleanupIntervalMs;

      try {
        const cleanupResult = await cleanupDispatchedClaimIngestQueueOutbox({
          prismaClient: prisma,
          olderThan: new Date(
            Date.now() - config.ingestQueueOutboxRetentionHours * 60 * 60 * 1_000,
          ),
          batchSize: config.ingestQueueOutboxCleanupBatchSize,
        });

        if (cleanupResult.selectedCount > 0 || cleanupResult.deletedCount > 0) {
          logInfo("claim_ingest_outbox_cleanup_completed", cleanupResult);
        }
      } catch (error: unknown) {
        captureWorkerException(error, {
          stage: "claim_ingest_outbox_cleanup",
          queueUrl: config.queueUrl,
        });
        logError("claim_ingest_outbox_cleanup_failed", {
          error: extractErrorMessage(error),
        });
      }
    }

    if (config.processingWatchdogEnabled && Date.now() >= nextWatchdogRunAt) {
      nextWatchdogRunAt = Date.now() + config.processingWatchdogIntervalMs;

      try {
        await recoverStaleProcessingClaims(
          {
            prismaClient: prisma,
            sqsClient,
            config,
          },
          {
            logInfoFn: logInfo,
            logErrorFn: logError,
          },
        );
      } catch (error: unknown) {
        captureWorkerException(error, {
          stage: "processing_watchdog",
          queueUrl: config.queueUrl,
        });
        logError("processing_watchdog_failed", {
          error: extractErrorMessage(error),
        });
      }
    }

    try {
      const dispatchResult = await dispatchPendingClaimIngestQueueOutbox({
        prismaClient: prisma,
        batchSize: DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_BATCH_SIZE,
        sendMessageFn: async (dispatchInput) => {
          try {
            const response = await sqsClient.send(
              new SendMessageCommand({
                QueueUrl: dispatchInput.queueUrl,
                MessageBody: JSON.stringify(dispatchInput.message),
                DelaySeconds: dispatchInput.delaySeconds,
              }),
            );

            return {
              ok: true,
              sqsMessageId: typeof response.MessageId === "string" ? response.MessageId : null,
            };
          } catch (error: unknown) {
            return {
              ok: false,
              error: extractErrorMessage(error),
            };
          }
        },
      });

      if (dispatchResult.selectedCount > 0) {
        logInfo("claim_ingest_outbox_dispatch_completed", dispatchResult);
      }
    } catch (error: unknown) {
      captureWorkerException(error, {
        stage: "claim_ingest_outbox_dispatch",
        queueUrl: config.queueUrl,
      });
      logError("claim_ingest_outbox_dispatch_failed", {
        error: extractErrorMessage(error),
      });
    }

    let messages: Message[];

    try {
      const response = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: config.queueUrl,
          MaxNumberOfMessages: config.maxMessages,
          WaitTimeSeconds: config.pollWaitSeconds,
          VisibilityTimeout: config.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      messages = response.Messages ?? [];
    } catch (error: unknown) {
      captureWorkerException(error, {
        stage: "receive_message",
        queueUrl: config.queueUrl,
      });
      logError("queue_receive_failed", { error: extractErrorMessage(error) });
      await sleep(config.errorDelayMs);
      continue;
    }

    if (messages.length === 0) {
      await sleep(config.idleDelayMs);
      continue;
    }

    const inFlight = new Set<Promise<void>>();
    for (const message of messages) {
      if (shuttingDown) {
        break;
      }

      const task = handleQueueMessage(config, sqsClient, message).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);

      if (inFlight.size >= config.processingConcurrency) {
        await Promise.race(inFlight);
      }
    }

    if (inFlight.size > 0) {
      await Promise.all(inFlight);
    }
  }

  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);
  logInfo("worker_stopped", {});
}

async function handleQueueMessage(
  config: WorkerConfig,
  sqsClient: SQSClient,
  sqsMessage: Message,
): Promise<void> {
  await handleClaimQueueMessage(
    {
      config,
      sqsClient,
      sqsMessage,
    },
    {
      processClaimIngestJobFn: (jobConfig, queueMessage) =>
        processClaimIngestJob(prisma, jobConfig, queueMessage, {
          logInfoFn: logInfo,
          logErrorFn: logError,
        }),
      captureExceptionFn: captureWorkerException,
      logInfoFn: logInfo,
      logErrorFn: logError,
      markClaimAsErrorFn: async (failureInput) => {
        await markClaimAsError(prisma, failureInput);
      },
      releaseClaimProcessingLeaseFn: async (leaseInput) => {
        await releaseClaimProcessingLease(prisma, leaseInput);
      },
    },
  );
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
