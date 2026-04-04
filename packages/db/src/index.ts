import { PrismaClient } from "@prisma/client";
export {
  CLAIM_PROCESSING_RECOVERY_SOURCES,
  CLAIM_PROCESSING_START_SOURCES,
  recordProcessingRecoveryIfStale,
  startClaimProcessingAttemptIfCurrent,
} from "./claim-processing.js";
export {
  CLAIM_INGEST_QUEUE_OUTBOX_DISPATCH_LEASE_TIMEOUT_MS,
  DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_CLEANUP_BATCH_SIZE,
  DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_BATCH_SIZE,
  DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_DISPATCH_CONCURRENCY,
  DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_MAX_BATCHES_PER_RUN,
  buildClaimIngestQueueMessage,
  cleanupDispatchedClaimIngestQueueOutbox,
  createClaimIngestQueueOutboxEntry,
  dispatchClaimIngestQueueOutboxById,
  dispatchPendingClaimIngestQueueOutbox,
  getClaimIngestQueueAvailableAt,
  loadClaimIngestQueueOutboxSummary,
  normalizeClaimIngestQueueDelaySeconds,
} from "./claim-ingest-queue-outbox.js";
export type {
  ClaimIngestQueueOutboxSummary,
  ClaimIngestQueueMessageV3,
  ClaimIngestQueueOutboxDispatchOutcome,
  ClaimIngestQueueSendInput,
  ClaimIngestQueueSendResult,
  CleanupDispatchedClaimIngestQueueOutboxResult,
  DispatchPendingClaimIngestQueueOutboxResult,
} from "./claim-ingest-queue-outbox.js";
export { recordClaimStatusTransition, transitionClaimStatusIfCurrent } from "./claim-status.js";

const prismaGlobal = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = prismaGlobal.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.prisma = prisma;
}
