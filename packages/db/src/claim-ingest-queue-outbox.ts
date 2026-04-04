import { Prisma, type PrismaClient } from "@prisma/client";

const claimIngestQueueOutboxDispatchSelect = {
  id: true,
  organizationId: true,
  claimId: true,
  inboundMessageId: true,
  providerMessageId: true,
  queueUrl: true,
  processingAttempt: true,
  processingLeaseToken: true,
  availableAt: true,
  dispatchedAt: true,
} as const satisfies Prisma.ClaimIngestQueueOutboxSelect;

type ClaimIngestQueueOutboxDispatchRecord = Prisma.ClaimIngestQueueOutboxGetPayload<{
  select: typeof claimIngestQueueOutboxDispatchSelect;
}>;

type ClaimIngestQueueOutboxClient = Pick<PrismaClient, "$queryRaw" | "claimIngestQueueOutbox">;

export const CLAIM_INGEST_QUEUE_OUTBOX_DISPATCH_LEASE_TIMEOUT_MS = 60_000;
export const DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_BATCH_SIZE = 25;
export const DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_DISPATCH_CONCURRENCY = 5;
export const DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_MAX_BATCHES_PER_RUN = 4;
export const DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_CLEANUP_BATCH_SIZE = 500;

export type ClaimIngestQueueMessageV3 = {
  version: 3;
  claimId: string;
  organizationId: string;
  inboundMessageId: string;
  providerMessageId: string;
  enqueuedAt: string;
  processingAttempt: number;
  processingLeaseToken: string;
};

export type ClaimIngestQueueSendInput = {
  queueUrl: string;
  message: ClaimIngestQueueMessageV3;
  delaySeconds?: number;
};

export type ClaimIngestQueueSendResult =
  | {
      ok: true;
      sqsMessageId?: string | null;
    }
  | {
      ok: false;
      error: string;
    };

export type ClaimIngestQueueOutboxDispatchOutcome =
  | {
      kind: "dispatched";
      outboxId: string;
      queueUrl: string;
      sqsMessageId: string | null;
      persisted: boolean;
    }
  | {
      kind: "already_dispatched" | "lease_unavailable";
      outboxId: string;
      queueUrl: string;
    }
  | {
      kind: "not_found";
      outboxId: string;
    }
  | {
      kind: "send_failed";
      outboxId: string;
      queueUrl: string;
      error: string;
    };

export type DispatchPendingClaimIngestQueueOutboxResult = {
  selectedCount: number;
  dispatchedCount: number;
  skippedCount: number;
  failedCount: number;
};

export type ClaimIngestQueueOutboxSummary = {
  pendingCount: number;
  dueCount: number;
  oldestPendingAgeMinutes: number | null;
  oldestPendingCreatedAt: Date | null;
  oldestDueAgeMinutes: number | null;
  oldestDueAvailableAt: Date | null;
};

export type CleanupDispatchedClaimIngestQueueOutboxResult = {
  selectedCount: number;
  deletedCount: number;
};

export function buildClaimIngestQueueMessage(input: {
  claimId: string;
  organizationId: string;
  inboundMessageId: string;
  providerMessageId: string;
  enqueuedAt: Date;
  processingAttempt: number;
  processingLeaseToken: string;
}): ClaimIngestQueueMessageV3 {
  return {
    version: 3,
    claimId: input.claimId,
    organizationId: input.organizationId,
    inboundMessageId: input.inboundMessageId,
    providerMessageId: input.providerMessageId,
    enqueuedAt: input.enqueuedAt.toISOString(),
    processingAttempt: input.processingAttempt,
    processingLeaseToken: input.processingLeaseToken,
  };
}

export function normalizeClaimIngestQueueDelaySeconds(
  value: number | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(Math.max(Math.floor(value), 0), 900);
}

export function getClaimIngestQueueAvailableAt(now: Date, delaySeconds?: number): Date {
  const normalizedDelaySeconds = normalizeClaimIngestQueueDelaySeconds(delaySeconds) ?? 0;
  return new Date(now.getTime() + normalizedDelaySeconds * 1_000);
}

export async function createClaimIngestQueueOutboxEntry(input: {
  tx: Prisma.TransactionClient;
  id: string;
  organizationId: string;
  claimId: string;
  inboundMessageId: string;
  providerMessageId: string;
  queueUrl: string;
  processingAttempt: number;
  processingLeaseToken: string;
  availableAt: Date;
}): Promise<void> {
  await input.tx.claimIngestQueueOutbox.create({
    data: {
      id: input.id,
      organizationId: input.organizationId,
      claimId: input.claimId,
      inboundMessageId: input.inboundMessageId,
      providerMessageId: input.providerMessageId,
      queueUrl: input.queueUrl,
      processingAttempt: input.processingAttempt,
      processingLeaseToken: input.processingLeaseToken,
      availableAt: input.availableAt,
    },
  });
}

export async function loadClaimIngestQueueOutboxSummary(input: {
  prismaClient: ClaimIngestQueueOutboxClient;
  organizationId?: string;
  now?: Date;
}): Promise<ClaimIngestQueueOutboxSummary> {
  const now = input.now ?? new Date();
  const nowSqlTimestamp = formatSqlTimestamp(now);
  const summaryRows = await input.prismaClient.$queryRaw<
    Array<{
      pendingCount: number;
      dueCount: number;
      oldestPendingCreatedAt: Date | null;
      oldestDueAvailableAt: Date | null;
    }>
  >(Prisma.sql`
    SELECT
      SUM(
        CASE
          WHEN "dispatchedAt" IS NULL THEN 1
          ELSE 0
        END
      )::int AS "pendingCount",
      SUM(
        CASE
          WHEN "dispatchedAt" IS NULL AND "availableAt" <= ${nowSqlTimestamp}::timestamp THEN 1
          ELSE 0
        END
      )::int AS "dueCount",
      MIN(
        CASE
          WHEN "dispatchedAt" IS NULL THEN "createdAt"
          ELSE NULL
        END
      ) AS "oldestPendingCreatedAt",
      MIN(
        CASE
          WHEN "dispatchedAt" IS NULL
            AND "availableAt" <= ${nowSqlTimestamp}::timestamp THEN "availableAt"
          ELSE NULL
        END
      ) AS "oldestDueAvailableAt"
    FROM "ClaimIngestQueueOutbox"
    ${input.organizationId ? Prisma.sql`WHERE "organizationId" = ${input.organizationId}` : Prisma.empty}
  `);
  const summary = summaryRows[0] ?? {
    pendingCount: 0,
    dueCount: 0,
    oldestPendingCreatedAt: null,
    oldestDueAvailableAt: null,
  };

  return {
    pendingCount: summary.pendingCount,
    dueCount: summary.dueCount,
    oldestPendingAgeMinutes: summary.oldestPendingCreatedAt
      ? getAgeMinutes(now, summary.oldestPendingCreatedAt)
      : null,
    oldestPendingCreatedAt: summary.oldestPendingCreatedAt,
    oldestDueAgeMinutes: summary.oldestDueAvailableAt
      ? getAgeMinutes(now, summary.oldestDueAvailableAt)
      : null,
    oldestDueAvailableAt: summary.oldestDueAvailableAt,
  };
}

export async function dispatchClaimIngestQueueOutboxById(
  input: {
    prismaClient: ClaimIngestQueueOutboxClient;
    outboxId: string;
    sendMessageFn: (input: ClaimIngestQueueSendInput) => Promise<ClaimIngestQueueSendResult>;
  },
  dependencies: {
    nowFn?: () => Date;
    createDispatchLeaseTokenFn?: () => string;
    dispatchLeaseTimeoutMs?: number;
  } = {},
): Promise<ClaimIngestQueueOutboxDispatchOutcome> {
  const now = (dependencies.nowFn ?? (() => new Date()))();
  const entry = await input.prismaClient.claimIngestQueueOutbox.findUnique({
    where: {
      id: input.outboxId,
    },
    select: claimIngestQueueOutboxDispatchSelect,
  });

  if (!entry) {
    return {
      kind: "not_found",
      outboxId: input.outboxId,
    };
  }

  if (entry.dispatchedAt) {
    return {
      kind: "already_dispatched",
      outboxId: entry.id,
      queueUrl: entry.queueUrl,
    };
  }

  const dispatchLeaseToken = (dependencies.createDispatchLeaseTokenFn ?? defaultCreateLeaseToken)();
  const dispatchLeaseTimeoutMs =
    dependencies.dispatchLeaseTimeoutMs ?? CLAIM_INGEST_QUEUE_OUTBOX_DISPATCH_LEASE_TIMEOUT_MS;
  const dispatchLeaseStaleBefore = new Date(now.getTime() - dispatchLeaseTimeoutMs);

  const claimed = await input.prismaClient.claimIngestQueueOutbox.updateMany({
    where: {
      id: entry.id,
      dispatchedAt: null,
      OR: [
        {
          dispatchLeaseClaimedAt: null,
        },
        {
          dispatchLeaseClaimedAt: {
            lte: dispatchLeaseStaleBefore,
          },
        },
      ],
    },
    data: {
      dispatchLeaseToken,
      dispatchLeaseClaimedAt: now,
      dispatchAttempts: {
        increment: 1,
      },
      lastDispatchAttemptAt: now,
      lastDispatchError: null,
    },
  });

  if (claimed.count !== 1) {
    return {
      kind: "lease_unavailable",
      outboxId: entry.id,
      queueUrl: entry.queueUrl,
    };
  }

  const sendResult = await sendClaimIngestQueueMessage(entry, now, input.sendMessageFn);
  if (!sendResult.ok) {
    await clearClaimIngestQueueOutboxDispatchLease(input.prismaClient, {
      outboxId: entry.id,
      dispatchLeaseToken,
      error: sendResult.error,
    });

    return {
      kind: "send_failed",
      outboxId: entry.id,
      queueUrl: entry.queueUrl,
      error: sendResult.error,
    };
  }

  try {
    const persisted = await input.prismaClient.claimIngestQueueOutbox.updateMany({
      where: {
        id: entry.id,
        dispatchedAt: null,
        dispatchLeaseToken,
      },
      data: {
        dispatchedAt: now,
        sqsMessageId: sendResult.sqsMessageId ?? null,
        dispatchLeaseToken: null,
        dispatchLeaseClaimedAt: null,
        lastDispatchError: null,
      },
    });

    return {
      kind: "dispatched",
      outboxId: entry.id,
      queueUrl: entry.queueUrl,
      sqsMessageId: sendResult.sqsMessageId ?? null,
      persisted: persisted.count === 1,
    };
  } catch {
    return {
      kind: "dispatched",
      outboxId: entry.id,
      queueUrl: entry.queueUrl,
      sqsMessageId: sendResult.sqsMessageId ?? null,
      persisted: false,
    };
  }
}

export async function dispatchPendingClaimIngestQueueOutbox(
  input: {
    prismaClient: ClaimIngestQueueOutboxClient;
    sendMessageFn: (input: ClaimIngestQueueSendInput) => Promise<ClaimIngestQueueSendResult>;
    batchSize?: number;
    concurrency?: number;
    maxBatches?: number;
  },
  dependencies: {
    nowFn?: () => Date;
    createDispatchLeaseTokenFn?: () => string;
    dispatchLeaseTimeoutMs?: number;
    dispatchByIdFn?: typeof dispatchClaimIngestQueueOutboxById;
  } = {},
): Promise<DispatchPendingClaimIngestQueueOutboxResult> {
  const now = (dependencies.nowFn ?? (() => new Date()))();
  const dispatchLeaseTimeoutMs =
    dependencies.dispatchLeaseTimeoutMs ?? CLAIM_INGEST_QUEUE_OUTBOX_DISPATCH_LEASE_TIMEOUT_MS;
  const dispatchLeaseStaleBefore = new Date(now.getTime() - dispatchLeaseTimeoutMs);
  const batchSize = input.batchSize ?? DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_BATCH_SIZE;
  const concurrency = normalizeDispatchConcurrency(input.concurrency);
  const maxBatches = normalizeDispatchMaxBatches(input.maxBatches);
  const dispatchByIdFn = dependencies.dispatchByIdFn ?? dispatchClaimIngestQueueOutboxById;

  const result: DispatchPendingClaimIngestQueueOutboxResult = {
    selectedCount: 0,
    dispatchedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const pendingEntries = await input.prismaClient.claimIngestQueueOutbox.findMany({
      where: {
        dispatchedAt: null,
        OR: [
          {
            dispatchLeaseClaimedAt: null,
          },
          {
            dispatchLeaseClaimedAt: {
              lte: dispatchLeaseStaleBefore,
            },
          },
        ],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: {
        id: true,
      },
    });

    result.selectedCount += pendingEntries.length;

    if (pendingEntries.length === 0) {
      break;
    }

    await runWithConcurrency(pendingEntries, concurrency, async (pendingEntry) => {
      const dispatchResult = await dispatchByIdFn(
        {
          prismaClient: input.prismaClient,
          outboxId: pendingEntry.id,
          sendMessageFn: input.sendMessageFn,
        },
        {
          nowFn: () => now,
          createDispatchLeaseTokenFn: dependencies.createDispatchLeaseTokenFn,
          dispatchLeaseTimeoutMs,
        },
      );

      if (dispatchResult.kind === "dispatched") {
        result.dispatchedCount += 1;
        return;
      }

      if (dispatchResult.kind === "send_failed") {
        result.failedCount += 1;
        return;
      }

      result.skippedCount += 1;
    });

    if (pendingEntries.length < batchSize) {
      break;
    }
  }

  return result;
}

export async function cleanupDispatchedClaimIngestQueueOutbox(input: {
  prismaClient: ClaimIngestQueueOutboxClient;
  olderThan: Date;
  batchSize?: number;
}): Promise<CleanupDispatchedClaimIngestQueueOutboxResult> {
  const batchSize = input.batchSize ?? DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_CLEANUP_BATCH_SIZE;
  const candidates = await input.prismaClient.claimIngestQueueOutbox.findMany({
    where: {
      dispatchedAt: {
        lt: input.olderThan,
      },
    },
    orderBy: [{ dispatchedAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: {
      id: true,
    },
  });

  if (candidates.length === 0) {
    return {
      selectedCount: 0,
      deletedCount: 0,
    };
  }

  const deleted = await input.prismaClient.claimIngestQueueOutbox.deleteMany({
    where: {
      id: {
        in: candidates.map((candidate) => candidate.id),
      },
      dispatchedAt: {
        lt: input.olderThan,
      },
    },
  });

  return {
    selectedCount: candidates.length,
    deletedCount: deleted.count,
  };
}

async function sendClaimIngestQueueMessage(
  entry: ClaimIngestQueueOutboxDispatchRecord,
  now: Date,
  sendMessageFn: (input: ClaimIngestQueueSendInput) => Promise<ClaimIngestQueueSendResult>,
): Promise<ClaimIngestQueueSendResult> {
  try {
    return await sendMessageFn({
      queueUrl: entry.queueUrl,
      message: buildClaimIngestQueueMessage({
        claimId: entry.claimId,
        organizationId: entry.organizationId,
        inboundMessageId: entry.inboundMessageId,
        providerMessageId: entry.providerMessageId,
        enqueuedAt: now,
        processingAttempt: entry.processingAttempt,
        processingLeaseToken: entry.processingLeaseToken,
      }),
      delaySeconds: getRemainingDelaySeconds(now, entry.availableAt),
    });
  } catch (error: unknown) {
    return {
      ok: false,
      error: getErrorMessage(error),
    };
  }
}

async function clearClaimIngestQueueOutboxDispatchLease(
  prismaClient: ClaimIngestQueueOutboxClient,
  input: {
    outboxId: string;
    dispatchLeaseToken: string;
    error: string;
  },
): Promise<void> {
  try {
    await prismaClient.claimIngestQueueOutbox.updateMany({
      where: {
        id: input.outboxId,
        dispatchedAt: null,
        dispatchLeaseToken: input.dispatchLeaseToken,
      },
      data: {
        dispatchLeaseToken: null,
        dispatchLeaseClaimedAt: null,
        lastDispatchError: input.error,
      },
    });
  } catch {
    // Leave the claimed row to expire so another dispatcher can safely retry.
  }
}

function getRemainingDelaySeconds(now: Date, availableAt: Date): number | undefined {
  const remainingMs = availableAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return undefined;
  }

  return normalizeClaimIngestQueueDelaySeconds(Math.ceil(remainingMs / 1_000));
}

function defaultCreateLeaseToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeDispatchConcurrency(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

function normalizeDispatchMaxBatches(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_MAX_BATCHES_PER_RUN;
  }

  return Math.max(1, Math.floor(value));
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= items.length) {
          return;
        }

        await worker(items[currentIndex] as T);
      }
    }),
  );
}

function formatSqlTimestamp(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown queue dispatch error.";
}

function getAgeMinutes(now: Date, then: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60_000));
}
