import type { Prisma, PrismaClient } from "@prisma/client";

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

type ClaimIngestQueueOutboxClient = Pick<PrismaClient, "claimIngestQueueOutbox">;

export const CLAIM_INGEST_QUEUE_OUTBOX_DISPATCH_LEASE_TIMEOUT_MS = 60_000;
export const DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_BATCH_SIZE = 25;
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

export function normalizeClaimIngestQueueDelaySeconds(value: number | undefined): number | undefined {
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
  const pendingWhere: Prisma.ClaimIngestQueueOutboxWhereInput = {
    dispatchedAt: null,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
  };
  const dueWhere: Prisma.ClaimIngestQueueOutboxWhereInput = {
    ...pendingWhere,
    availableAt: {
      lte: now,
    },
  };

  const [pendingCount, dueCount, oldestPending, oldestDue] = await Promise.all([
    input.prismaClient.claimIngestQueueOutbox.count({
      where: pendingWhere,
    }),
    input.prismaClient.claimIngestQueueOutbox.count({
      where: dueWhere,
    }),
    input.prismaClient.claimIngestQueueOutbox.findFirst({
      where: pendingWhere,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        createdAt: true,
      },
    }),
    input.prismaClient.claimIngestQueueOutbox.findFirst({
      where: dueWhere,
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
      select: {
        availableAt: true,
      },
    }),
  ]);

  return {
    pendingCount,
    dueCount,
    oldestPendingAgeMinutes: oldestPending
      ? getAgeMinutes(now, oldestPending.createdAt)
      : null,
    oldestPendingCreatedAt: oldestPending?.createdAt ?? null,
    oldestDueAgeMinutes: oldestDue ? getAgeMinutes(now, oldestDue.availableAt) : null,
    oldestDueAvailableAt: oldestDue?.availableAt ?? null,
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
  },
  dependencies: {
    nowFn?: () => Date;
    createDispatchLeaseTokenFn?: () => string;
    dispatchLeaseTimeoutMs?: number;
  } = {},
): Promise<DispatchPendingClaimIngestQueueOutboxResult> {
  const now = (dependencies.nowFn ?? (() => new Date()))();
  const dispatchLeaseTimeoutMs =
    dependencies.dispatchLeaseTimeoutMs ?? CLAIM_INGEST_QUEUE_OUTBOX_DISPATCH_LEASE_TIMEOUT_MS;
  const dispatchLeaseStaleBefore = new Date(now.getTime() - dispatchLeaseTimeoutMs);
  const batchSize = input.batchSize ?? DEFAULT_CLAIM_INGEST_QUEUE_OUTBOX_BATCH_SIZE;
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

  const result: DispatchPendingClaimIngestQueueOutboxResult = {
    selectedCount: pendingEntries.length,
    dispatchedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  for (const pendingEntry of pendingEntries) {
    const dispatchResult = await dispatchClaimIngestQueueOutboxById(
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
      continue;
    }

    if (dispatchResult.kind === "send_failed") {
      result.failedCount += 1;
      continue;
    }

    result.skippedCount += 1;
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown queue dispatch error.";
}

function getAgeMinutes(now: Date, then: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60_000));
}
